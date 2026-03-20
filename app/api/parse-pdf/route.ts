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
        // Parsear TODO el PDF a veces falla (0 transacciones) porque incluye ruido
        // de otras secciones. Para "Corrientes" debe iniciarse desde "ACTIVIDADES",
        // y además necesitamos conservar filas finales (ej. 31-01).
        //
        // Estrategia:
        // - Probar múltiples ocurrencias de "ACTIVIDADES" (todas las que estén después
        //   de "ESTADO DE CUENTA CORRIENTE").
        // - Quedarnos con la que produzca más transacciones.
        // - Filtrar desde la primera fecha DD-MM encontrada en esa sección
        //   (sin descartar filas si el OCR no reconoce la fecha en esa línea).

        // Fallback robusto: si los slices fallan, intentamos con el PDF completo.
        let rawAllFallback: ReturnType<typeof parseTransactions> | null = null;
        try {
          rawAllFallback = parseTransactions(text);
        } catch {
          // Se maneja al final.
        }

        const activStarts: number[] = [];
        for (let pos = searchFrom; ; ) {
          const idx = upper.indexOf('ACTIVIDADES', pos);
          if (idx < 0) break;
          activStarts.push(idx);
          pos = idx + 'ACTIVIDADES'.length;
        }

        let bestRaw: ReturnType<typeof parseTransactions> | null = null;
        let bestIdxActividades: number | null = null;
        let bestMaxDate: { day: number; month: number } | null = null;

        const getMaxDate = (
          raw: ReturnType<typeof parseTransactions>
        ): { day: number; month: number } | null => {
          let max: { day: number; month: number } | null = null;
          for (const tx of raw) {
            const m = (tx.fechaProc || '').match(/^(\d{1,2})-(\d{1,2})$/);
            if (!m) continue;
            const day = parseInt(m[1], 10);
            const month = parseInt(m[2], 10);
            if (month < 1 || month > 12) continue;
            if (day < 1 || day > 31) continue;
            if (!max) {
              max = { day, month };
              continue;
            }
            if (month > max.month || (month === max.month && day > max.day)) {
              max = { day, month };
            }
          }
          return max;
        };

        for (const idxActividades of activStarts.length ? activStarts : [searchFrom]) {
          try {
            const candidateText = text.slice(idxActividades);
            const candidateRaw = parseTransactions(candidateText);
            if (candidateRaw && candidateRaw.length > 0) {
              const candidateMax = getMaxDate(candidateRaw);
              const candidateBetter =
                !bestRaw ||
                !bestMaxDate ||
                (candidateMax &&
                  (candidateMax.month > bestMaxDate.month ||
                    (candidateMax.month === bestMaxDate.month &&
                      candidateMax.day > bestMaxDate.day)));

              const tieBreakerByCount =
                bestRaw && candidateRaw.length > bestRaw.length;

              if (candidateBetter || tieBreakerByCount) {
                bestRaw = candidateRaw;
                bestIdxActividades = idxActividades;
                bestMaxDate = candidateMax;
              }
            }
          } catch {
            // Try next ACTIVIDADES occurrence.
          }
        }

        if (!bestRaw || bestRaw.length === 0) {
          // Last resort: intentar desde ESTADO DE CUENTA CORRIENTE o el inicio.
          const fallbackText = searchFrom > 0 ? text.slice(searchFrom) : text;
          try {
            bestRaw = parseTransactions(fallbackText);
            bestIdxActividades = searchFrom > 0 ? searchFrom : null;
          } catch {
            // Si incluso el fallback falla, usamos el PDF completo (si logró parsear).
            if (rawAllFallback && rawAllFallback.length > 0) {
              bestRaw = rawAllFallback;
              bestIdxActividades = null;
            } else {
              throw new Error(
                'No se encontraron transacciones en los candidatos ni en el fallback.'
              );
            }
          }
        }

        const chosenStart = bestIdxActividades ?? searchFrom;
        const candidateTail = text.slice(chosenStart);
        // Evitar falsos positivos como "0-07" (OCR/noise) y forzar day 1..31, month 1..12.
        const ddmmMatch = candidateTail.match(
          /\b(0?[1-9]|[12]\d|3[01])-(0?[1-9]|1[0-2])\b/
        );

        const raw = (() => {
          if (!ddmmMatch || !ddmmMatch[1] || !ddmmMatch[2]) return bestRaw!;
          const dd = parseInt(ddmmMatch[1], 10);
          const mm = parseInt(ddmmMatch[2], 10);
          const filtered = bestRaw!.filter((tx) => {
            const m = tx.fechaProc.match(/^(\d{1,2})-(\d{1,2})$/);
            // Si el OCR no logra un "DD-MM" limpio, no descartamos la fila;
            // el extractor debe conservar esas filas (especialmente al final de página).
            if (!m) return true;
            const d = parseInt(m[1], 10);
            const mon = parseInt(m[2], 10);
            return mon === mm && d >= dd;
          });
          // Nunca devolvemos vacío solo por un match parcial del OCR.
          return filtered.length > 0 ? filtered : bestRaw!;
        })();

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

        // Para corregir variaciones del OCR (fechas repetidas que aparecen
        // en un orden no estrictamente cronologico), ordenamos establemente
        // por `fechaProc` (DD-MM). Esto solo afecta el orden de filas en Excel,
        // no cambia valores ni columnas.
        const parseFechaProcDDMM = (s: string): { day: number; month: number } | null => {
          const m = (s || '').match(/^(\d{1,2})-(\d{1,2})$/);
          if (!m) return null;
          const day = parseInt(m[1], 10);
          const month = parseInt(m[2], 10);
          if (month < 1 || month > 12 || day < 1 || day > 31) return null;
          return { day, month };
        };
        const withParsed = result.transactions.map((tx, idx) => ({
          tx,
          idx,
          parsed: parseFechaProcDDMM(tx.fechaProc),
        }));
        withParsed.sort((a, b) => {
          if (!a.parsed && !b.parsed) return a.idx - b.idx;
          if (!a.parsed) return 1;
          if (!b.parsed) return -1;
          if (a.parsed.month !== b.parsed.month) return a.parsed.month - b.parsed.month;
          if (a.parsed.day !== b.parsed.day) return a.parsed.day - b.parsed.day;
          return a.idx - b.idx;
        });
        result.transactions = withParsed.map((x) => x.tx);

        return NextResponse.json({
          ...result,
          statementType,
          parserSource: 'heuristic-text',
          extractionVersion: 'current-12col-from-actividades',
          parserDebug: {
            idxCorriente,
            idxActividades: bestIdxActividades,
            ddmmThreshold: (() => {
              const chosenStart = bestIdxActividades ?? searchFrom;
              const candidateTail = text.slice(chosenStart);
              const m = candidateTail.match(/\b(\d{1,2})-(\d{1,2})\b/);
              return m?.[0] ?? null;
            })(),
            activacionesProbadas: activStarts.length,
            bestTxCount: bestRaw?.length ?? 0,
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
