import { NextRequest, NextResponse } from 'next/server';
import pdfParse from 'pdf-parse';
import { parseTransactions, cleanAndValidateData } from '@/lib/pdf-processor';
import { extractBCPByColumns } from '@/lib/bcp-extract-by-columns';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        { error: 'No se proporciono un archivo' },
        { status: 400 }
      );
    }

    if (file.type !== 'application/pdf') {
      return NextResponse.json(
        { error: 'El archivo debe ser un PDF' },
        { status: 400 }
      );
    }

    // Convert file to buffer
    const buffer = await file.arrayBuffer();
    const data = await pdfParse(Buffer.from(buffer));

    // Extract text from PDF
    const text = data.text;

    // Parse transactions:
    // 1) Try exact column-based extraction (avoids guessing Debe/Haber)
    // 2) Fallback to heuristics
    let transactions = [] as ReturnType<typeof parseTransactions>;
    try {
      transactions = await extractBCPByColumns(buffer);
    } catch (e) {
      transactions = [];
    }
    if (!transactions || transactions.length < 5) {
      transactions = parseTransactions(text);
    }

    // Clean and validate data
    const result = cleanAndValidateData(transactions, text);

    return NextResponse.json(result);
  } catch (error) {
    console.error('PDF parsing error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'No se pudo analizar el PDF. Asegurate de que sea un archivo en formato Estado de cuenta PDF.',
      },
      { status: 500 }
    );
  }
}
