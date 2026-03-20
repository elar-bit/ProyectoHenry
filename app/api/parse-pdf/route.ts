import { NextRequest, NextResponse } from 'next/server';
import pdfParse from 'pdf-parse';
import {
  parseTransactions,
  cleanAndValidateData,
  cleanAndValidateCurrentAccountData,
  StatementType,
} from '@/lib/pdf-processor';
import { extractBCPByColumns } from '@/lib/bcp-extract-by-columns';
import { extractWithPdfPlumber } from '@/lib/extract-pdfplumber';
import { extractCorrientesSaldoContableByRows } from '@/lib/corrientes-extract-saldo';

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

    // Convert file to a stable buffer (avoid detached ArrayBuffer issues).
    const fileArrayBuffer = await file.arrayBuffer();
    const pdfBytes = Buffer.from(fileArrayBuffer);
    const makeArrayBuffer = () =>
      pdfBytes.buffer.slice(
        pdfBytes.byteOffset,
        pdfBytes.byteOffset + pdfBytes.byteLength
      );

    const data = await pdfParse(pdfBytes);
    const text = data.text;

    const looksLikeAltBCP =
      /(ESTADO\s+DE\s+CUENTA\s+CORRIENTE|IMPORT\s*&\s*EXPORT)/i.test(text);

    // Automatic statement type:
    // - "Ahorros": BCP tabular con CARGOS/DEBE y ABONOS/HABER (5 columnas).
    // - "Corrientes": formato alternativo con 12 columnas (desde ACTIVIDADES).
    const statementType: StatementType = looksLikeAltBCP
      ? 'corrientes'
      : 'ahorros';

    // Corrientes (12 columnas) -> heurística estructurada (por tokens).
    if (statementType === 'corrientes') {
      const upper = text.toUpperCase();
      const idxCorriente = upper.indexOf('ESTADO DE CUENTA CORRIENTE');
      const searchFrom = idxCorriente >= 0 ? idxCorriente : 0;

      try {
        // Solución robusta:
        // - Parseamos TODO el PDF para no perder filas finales (ej. 31-01).
        // - Luego filtramos para que el resultado empiece en la sección de "ACTIVIDADES"
        //   de "ESTADO DE CUENTA CORRIENTE".
        const rawAll = parseTransactions(text);

        const idxActividades = upper.indexOf('ACTIVIDADES', searchFrom);
        const tail = idxActividades >= 0 ? text.slice(idxActividades) : '';
        const ddmmMatch = tail.match(/\b(\d{1,2})-(\d{1,2})\b/);

        const raw =
          ddmmMatch && ddmmMatch[1] && ddmmMatch[2]
            ? (() => {
                const dd = parseInt(ddmmMatch[1], 10);
                const mm = parseInt(ddmmMatch[2], 10);
                return rawAll.filter((tx) => {
                  const m = tx.fechaProc.match(/^(\d{1,2})-(\d{1,2})$/);
                  // Si el OCR no logra un "DD-MM" limpio, no descartamos la fila;
                  // el extractor debe conservar esas filas (especialmente al final de página).
                  if (!m) return true;
                  const d = parseInt(m[1], 10);
                  const mon = parseInt(m[2], 10);
                  return mon === mm && d >= dd;
                });
              })()
            : rawAll;

        const result = cleanAndValidateCurrentAccountData(raw, text);

        // Reemplazar "Saldo Contable" por valores extraídos por coordenadas
        // (el monto más a la derecha en cada fila).
        try {
          const saldoTokens = await extractCorrientesSaldoContableByRows(
            makeArrayBuffer(),
            result.transactions.length
          );
          for (let i = 0; i < result.transactions.length; i++) {
            if (typeof saldoTokens[i] === 'number') {
              result.transactions[i].saldoContable =
                saldoTokens[i] ?? 0;
            }
          }
        } catch {
          // si falla la extracción de saldo por coordenadas, se mantiene el valor actual (0).
        }

        return NextResponse.json({
          ...result,
          statementType,
          parserSource: 'heuristic-text',
          extractionVersion: 'current-12col-from-actividades',
          parserDebug: {
            idxCorriente,
            idxActividades,
            ddmmThreshold: ddmmMatch?.[0] ?? null,
          },
        });
      } catch (e) {
        return NextResponse.json(
          {
            error:
              'No se pudo extraer el estado BCP para cuentas corrientes.',
            statementType,
            parserSource: 'none',
            parserDebug: e instanceof Error ? e.message : 'unknown',
          },
          { status: 422 }
        );
      }
    }

    // Ahorros (5 columnas): segmentación por columnas.
    let transactions = [] as ReturnType<typeof parseTransactions>;
    let parserSource: 'pdfplumber' | 'pdfjs-columns' | 'heuristic-text' =
      'heuristic-text';
    let pdfjsError: string | null = null;
    let plumberError: string | null = null;

    const looksLikeBCPColumns =
      /(CARGOS|DEBE)/i.test(text) && /(ABONOS|HABER)/i.test(text);

    try {
      transactions = await extractBCPByColumns(makeArrayBuffer());
      if (transactions.length > 0) parserSource = 'pdfjs-columns';
    } catch (e) {
      pdfjsError = e instanceof Error ? e.message : 'unknown';
      transactions = [];
    }

    if (!transactions || transactions.length === 0) {
      try {
        const plumb = extractWithPdfPlumber(makeArrayBuffer());
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
      // Para BCP tabular: no degradar a heurística (evita cargos/abonos incorrectos).
      if (looksLikeBCPColumns) {
        return NextResponse.json(
          {
            error:
              'No se pudo extraer el estado BCP con segmentacion por columnas.',
            parserSource: 'none',
            extractionVersion: 'v2-column-boundary',
            parserDebug: { pdfjsError, plumberError, looksLikeBCPColumns },
          },
          { status: 422 }
        );
      }

      // PDFs no tabulares BCP: fallback heurístico.
      transactions = parseTransactions(text);
      parserSource = 'heuristic-text';
    }

    const result = cleanAndValidateData(transactions, text);

    return NextResponse.json({
      ...result,
      parserSource,
      statementType,
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
