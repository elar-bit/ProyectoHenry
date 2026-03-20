import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

type StatementType = 'ahorros' | 'corrientes';

interface SavingsTransaction {
  fechaProc: string;
  fechaValor: string;
  description: string;
  debit: number;
  credit: number;
}

interface CurrentAccountTransaction {
  fechaProc: string;
  fechaValor: string;
  description: string;
  medat: string;
  lugar: string;
  sucAge: string;
  numOp: string;
  hora: string;
  origen: string;
  tipo: string;
  cargoAbono: number;
  saldoContable: string;
}

interface RequestData {
  statementType?: StatementType;
  transactions: Array<SavingsTransaction | CurrentAccountTransaction>;
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
    const statementType: StatementType =
      data.statementType === 'corrientes' ? 'corrientes' : 'ahorros';

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
    const excelData =
      statementType === 'corrientes'
        ? (data.transactions as CurrentAccountTransaction[]).map((tx) => ({
            'Fecha Proc.': tx.fechaProc,
            'Fecha Valor': tx.fechaValor,
            Descripcion: tx.description,
            'Medat*': tx.medat,
            Lugar: tx.lugar,
            'SUC-AGE': tx.sucAge,
            'NUM OP': tx.numOp,
            HORA: tx.hora,
            ORIGEN: tx.origen,
            TIPO: tx.tipo,
            'Cargo/Abono':
              typeof tx.cargoAbono === 'number' && tx.cargoAbono !== 0
                ? formatMoneyForExcel(tx.cargoAbono)
                : '',
            'Saldo Contable': tx.saldoContable || '',
          }))
        : (data.transactions as SavingsTransaction[]).map((tx) => ({
            'Fecha Proc.': tx.fechaProc,
            'Fecha Valor': tx.fechaValor,
            Descripcion: tx.description,
            'Cargos / Debe':
              typeof tx.debit === 'number' && tx.debit !== 0
                ? formatMoneyForExcel(tx.debit)
                : '',
            'Abonos / Haber':
              typeof tx.credit === 'number' && tx.credit !== 0
                ? formatMoneyForExcel(tx.credit)
                : '',
          }));

    // Create main sheet
    const worksheet = XLSX.utils.json_to_sheet(excelData);

    // Add formatting
    const wscols =
      statementType === 'corrientes'
        ? [
            { wch: 12 }, // Fecha Proc
            { wch: 12 }, // Fecha Valor
            { wch: 35 }, // Descripcion
            { wch: 12 }, // Medat*
            { wch: 12 }, // Lugar
            { wch: 12 }, // SUC-AGE
            { wch: 12 }, // NUM OP
            { wch: 10 }, // HORA
            { wch: 10 }, // ORIGEN
            { wch: 10 }, // TIPO
            { wch: 18 }, // Cargo/Abono
            { wch: 18 }, // Saldo Contable
          ]
        : [
            { wch: 12 }, // Fecha Proc
            { wch: 12 }, // Fecha Valor
            { wch: 35 }, // Descripcion
            { wch: 18 }, // Cargos / Debe
            { wch: 18 }, // Abonos / Haber
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

    // Format currency columns
    for (let row = 2; row <= excelData.length + 1; row++) {
      if (statementType === 'corrientes') {
        // Cargo/Abono column (K)
        const cargoCell = worksheet['K' + row];
        if (cargoCell) {
          if (typeof cargoCell.v === 'number') cargoCell.z = '#,##0.00';
          cargoCell.s = { alignment: { horizontal: 'right' } };
        }
      } else {
        // Debit column (D)
        const debitCell = worksheet['D' + row];
        if (debitCell) {
          if (typeof debitCell.v === 'number') debitCell.z = '#,##0.00';
          debitCell.s = { alignment: { horizontal: 'right' } };
        }

        // Credit column (E)
        const creditCell = worksheet['E' + row];
        if (creditCell) {
          if (typeof creditCell.v === 'number') creditCell.z = '#,##0.00';
          creditCell.s = { alignment: { horizontal: 'right' } };
        }
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
