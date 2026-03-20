import { NextRequest, NextResponse } from 'next/server';
import XLSX from 'xlsx';

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

    if (!data.transactions || data.transactions.length === 0) {
      return NextResponse.json(
        { error: 'No transactions to export' },
        { status: 400 }
      );
    }

    // Create workbook
    const workbook = XLSX.utils.book_new();

    // Prepare transactions data for Excel
    const excelData = data.transactions.map((tx) => ({
      Date: tx.date,
      Description: tx.description,
      Debit: tx.debit || '',
      Credit: tx.credit || '',
      Balance: tx.balance,
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
        debitCell.z = '#,##0.00';
        debitCell.s = {
          alignment: { horizontal: 'right' },
          numFmt: '#,##0.00',
        };
      }

      // Credit column (D)
      const creditCell = worksheet['D' + row];
      if (creditCell) {
        creditCell.z = '#,##0.00';
        creditCell.s = {
          alignment: { horizontal: 'right' },
          numFmt: '#,##0.00',
        };
      }

      // Balance column (E)
      const balanceCell = worksheet['E' + row];
      if (balanceCell) {
        balanceCell.z = '#,##0.00';
        balanceCell.s = {
          alignment: { horizontal: 'right' },
          numFmt: '#,##0.00',
        };
      }
    }

    // Create summary sheet
    const summarySheet = XLSX.utils.aoa_to_sheet([
      ['Bank Statement Summary'],
      [],
      ['Account Information'],
      ['Account Number', data.accountInfo.accountNumber || 'N/A'],
      ['Total Transactions', data.transactions.length],
      [],
      ['Balance Information'],
      ['Total Debits', data.accountInfo.totalDebits || 0],
      ['Total Credits', data.accountInfo.totalCredits || 0],
      ['Report Balance', data.accountInfo.reportBalance || 0],
      ['Calculated Balance', data.accountInfo.calculatedBalance || 0],
      [],
      [
        'Status',
        data.accountInfo.reportBalance === data.accountInfo.calculatedBalance
          ? 'VALID'
          : 'BALANCE MISMATCH',
      ],
    ]);

    // Format summary sheet
    summarySheet['!cols'] = [{ wch: 25 }, { wch: 20 }];

    // Add summary to workbook
    XLSX.utils.book_append_sheet(
      workbook,
      worksheet,
      'Transactions'
    );
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

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
        'Content-Disposition': `attachment; filename="bank-statement-${new Date().toISOString().split('T')[0]}.xlsx"`,
      },
    });
  } catch (error) {
    console.error('Excel generation error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to generate Excel file',
      },
      { status: 500 }
    );
  }
}
