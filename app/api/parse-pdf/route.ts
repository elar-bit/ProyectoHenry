import { NextRequest, NextResponse } from 'next/server';
import pdfParse from 'pdf-parse';
import { parseTransactions, cleanAndValidateData } from '@/lib/pdf-processor';
import { extractBCPByColumns } from '@/lib/bcp-extract-by-columns';
import { extractWithPdfPlumber } from '@/lib/extract-pdfplumber';

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
    // 1) pdfplumber (Python): tablas + palabras alineadas a encabezados DEBE/HABER
    // 2) pdfjs-dist en TypeScript (sin Python / Vercel)
    // 3) Heurísticas sobre texto plano
    let transactions = [] as ReturnType<typeof parseTransactions>;
    let parserSource: 'pdfplumber' | 'pdfjs-columns' | 'heuristic-text' = 'heuristic-text';
    try {
      const plumb = extractWithPdfPlumber(buffer);
      if (plumb && plumb.length > 0) {
        transactions = plumb;
        parserSource = 'pdfplumber';
      }
    } catch {
      transactions = [];
    }
    if (!transactions || transactions.length === 0) {
      try {
        transactions = await extractBCPByColumns(buffer);
        if (transactions.length > 0) {
          parserSource = 'pdfjs-columns';
        }
      } catch {
        transactions = [];
      }
    }
    if (!transactions || transactions.length === 0) {
      // Fallback final para no bloquear la conversión.
      transactions = parseTransactions(text);
      parserSource = 'heuristic-text';
    }

    // Clean and validate data
    const result = cleanAndValidateData(transactions, text);

    return NextResponse.json({
      ...result,
      parserSource,
    });
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
