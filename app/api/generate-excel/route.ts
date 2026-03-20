import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

interface Transaction {
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

interface RequestData {
  transactions: Transaction[];
  accountInfo: {
    accountNumber?: string;
    reportBalance?: number;
    calculatedBalance?: number;
    totalDebits?: number;
    totalCredits?: number;
  };
}

export async function POST(request: NextRequest) {
  try {
    const data: RequestData = await request.json();

    const formatMoneyForExcel = (value: number) =>
      value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    if (!data.transactions || data.transactions.length === 0) {
      return NextResponse.json(
        { error: 'No hay transacciones para exportar' },
        { status: 400 }
      );
    }

    // Create workbook
    const workbook = XLSX.utils.book_new();

    // Prepare transactions data for Excel
    const excelData = data.transactions.map((tx) => ({
      Fecha: tx.date,
      Descripcion: tx.description,
      Debito:
        typeof tx.debit === 'number' && tx.debit !== 0
          ? formatMoneyForExcel(tx.debit)
          : '',
      Credito:
        typeof tx.credit === 'number' && tx.credit !== 0
          ? formatMoneyForExcel(tx.credit)
          : '',
      Saldo:
        typeof tx.balance === 'number' ? formatMoneyForExcel(tx.balance) : tx.balance || '',
    }));

    // Create main sheet
    const worksheet = XLSX.utils.json_to_sheet(excelData);

    // Add formatting
    const wscols = [
      { wch: 12 }, // Date
      { wch: 35 }, // Description
      { wch: 15 }, // Debit
      { wch: 15 }, // Credit
      { wch: 15 }, // Balance
    ];
    worksheet['!cols'] = wscols;

    // Style header row
    const headerStyle = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '1F2937' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      },
    };

    // Apply header styling
    const headerRange = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
    for (let col = headerRange.s.c; col <= headerRange.e.c; col++) {
      const cellAddress = XLSX.utils.encode_col(col) + '1';
      if (worksheet[cellAddress]) {
        worksheet[cellAddress].s = headerStyle;
      }
    }

    // Format currency columns (Debit, Credit, Balance)
    for (
      let row = 2;
      row <= excelData.length + 1;
      row++
    ) {
      // Debit column (C)
      const debitCell = worksheet['C' + row];
      if (debitCell) {
        if (typeof debitCell.v === 'number') {
          debitCell.z = '#,##0.00';
        }
        debitCell.s = {
          alignment: { horizontal: 'right' },
        };
      }

      // Credit column (D)
      const creditCell = worksheet['D' + row];
      if (creditCell) {
        if (typeof creditCell.v === 'number') {
          creditCell.z = '#,##0.00';
        }
        creditCell.s = {
          alignment: { horizontal: 'right' },
        };
      }

      // Balance column (E)
      const balanceCell = worksheet['E' + row];
      if (balanceCell) {
        if (typeof balanceCell.v === 'number') {
          balanceCell.z = '#,##0.00';
        }
        balanceCell.s = {
          alignment: { horizontal: 'right' },
        };
      }
    }

    // Create summary sheet
    const summarySheet = XLSX.utils.aoa_to_sheet([
      ['Resumen del estado de cuenta'],
      [],
      ['Informacion de la cuenta'],
      ['Numero de cuenta', data.accountInfo.accountNumber || 'N/A'],
      ['Transacciones totales', data.transactions.length],
      [],
      ['Informacion de saldo'],
      ['Total debitos', data.accountInfo.totalDebits ?? ''],
      ['Total creditos', data.accountInfo.totalCredits ?? ''],
      ['Saldo reportado', data.accountInfo.reportBalance ?? ''],
      ['Saldo calculado', data.accountInfo.calculatedBalance ?? ''],
      [],
      [
        'Estado',
        typeof data.accountInfo.reportBalance === 'number' &&
        typeof data.accountInfo.calculatedBalance === 'number'
          ? data.accountInfo.reportBalance === data.accountInfo.calculatedBalance
            ? 'VALIDO'
            : 'DESAJUSTE DE SALDO'
          : 'SIN DATOS',
      ],
    ]);

    // Format summary sheet
    summarySheet['!cols'] = [{ wch: 25 }, { wch: 20 }];

    // Add summary to workbook
    XLSX.utils.book_append_sheet(
      workbook,
      worksheet,
      'Transacciones'
    );
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Resumen');

    // Generate file
    const excelBuffer = XLSX.write(workbook, {
      bookType: 'xlsx',
      type: 'array',
    });

    // Return as downloadable file
    return new NextResponse(excelBuffer, {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="estado-de-cuenta-${new Date().toISOString().split('T')[0]}.xlsx"`,
      },
    });
  } catch (error) {
    console.error('Excel generation error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'No se pudo generar el archivo de Excel',
      },
      { status: 500 }
    );
  }
}
