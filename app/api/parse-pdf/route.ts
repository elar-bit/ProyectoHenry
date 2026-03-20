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
    // 1) pdfjs-columns (motor principal BCP, validado 1:1)
    // 2) pdfplumber como respaldo técnico
    // 3) Heurística solo para PDFs no tabulares BCP
    let transactions = [] as ReturnType<typeof parseTransactions>;
    let parserSource: 'pdfplumber' | 'pdfjs-columns' | 'heuristic-text' =
      'heuristic-text';
    let pdfjsError: string | null = null;
    let plumberError: string | null = null;
    const looksLikeBCPColumns =
      /(CARGOS|DEBE)/i.test(text) && /(ABONOS|HABER)/i.test(text);

    if (!transactions || transactions.length === 0) {
      try {
        transactions = await extractBCPByColumns(buffer);
        if (transactions.length > 0) {
          parserSource = 'pdfjs-columns';
        }
      } catch (e) {
        pdfjsError = e instanceof Error ? e.message : 'unknown';
        transactions = [];
      }
    }

    if (!transactions || transactions.length === 0) {
      try {
        const plumb = extractWithPdfPlumber(buffer);
        if (plumb && plumb.length > 0) {
          transactions = plumb;
          parserSource = 'pdfplumber';
        }
      } catch (e) {
        plumberError = e instanceof Error ? e.message : 'unknown';
        transactions = [];
      }
    }

    if (!transactions || transactions.length === 0) {
      // Para BCP tabular, nunca degradar a heurística textual.
      if (looksLikeBCPColumns) {
        return NextResponse.json(
          {
            error:
              'No se pudo extraer el estado BCP con segmentacion por columnas.',
            parserSource: 'none',
            extractionVersion: 'v2-column-boundary',
            parserDebug:
              { pdfjsError, plumberError, looksLikeBCPColumns },
          },
          { status: 422 }
        );
      }
      // Fallback final para PDFs no tabulares.
      transactions = parseTransactions(text);
      parserSource = 'heuristic-text';
    }

    // Clean and validate data
    const result = cleanAndValidateData(transactions, text);

    return NextResponse.json({
      ...result,
      parserSource,
      extractionVersion: 'v2-column-boundary',
      parserDebug:
        process.env.NODE_ENV !== 'production'
          ? { pdfjsError, plumberError, looksLikeBCPColumns }
          : undefined,
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
