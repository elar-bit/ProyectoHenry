import type { ParsedTransaction } from '@/lib/pdf-processor';

type ExtractBCPResult = ParsedTransaction[];

const MONTHS = [
  'ENE',
  'JAN',
  'FEB',
  'MAR',
  'ABR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AGO',
  'AUG',
  'SEP',
  'OCT',
  'SET',
  'NOV',
  'DIC',
  'DEC',
] as const;

function isMonthToken(token: string) {
  return (MONTHS as readonly string[]).includes(token.toUpperCase());
}

function isAmountToken(str: string) {
  // Accept amounts like:
  //  - 686.00
  //  - 3,004.40
  //  - .85-
  //  - 0.05
  const s = str.trim();
  return /^-?\d[\d,]*([.]\d+)?$/.test(s) || /^[\d,]+\.\d+$/.test(s) || /^[-.]?\d[\d,]*([.]\d+)?-?$/.test(s);
}

function parseFechaTokenFromCombined(str: string) {
  const m = str.trim().match(/^(\d{1,2})([A-Za-z]{3})$/);
  if (!m) return null;
  if (!isMonthToken(m[2])) return null;
  const day = String(m[1]).padStart(2, '0');
  return `${day}${m[2].toUpperCase()}`;
}

function parseFechaTokenFromSplit(dayToken: string, monthToken: string) {
  const day = dayToken.trim().match(/^\d{1,2}$/);
  if (!day) return null;
  if (!isMonthToken(monthToken.trim())) return null;
  return `${String(dayToken).padStart(2, '0')}${monthToken.trim().toUpperCase()}`;
}

function extractFechaTokens(rowItems: Array<any>) {
  const sorted = [...rowItems].sort((a, b) => a.x - b.x);
  const out: string[] = [];
  let maxFechaX = -Infinity;

  for (let i = 0; i < sorted.length; i++) {
    const str = (sorted[i].str ?? '').toString().trim();
    const combined = parseFechaTokenFromCombined(str);
    if (combined) {
      out.push(combined);
      maxFechaX = Math.max(maxFechaX, sorted[i].x);
      continue;
    }

    // Split token form: "02" + "FEB"
    const dayOk = /^\d{1,2}$/.test(str);
    if (!dayOk) continue;
    const next = sorted[i + 1];
    if (!next) continue;
    const nextStr = (next.str ?? '').toString().trim();
    const split = parseFechaTokenFromSplit(str, nextStr);
    if (split) {
      out.push(split);
      maxFechaX = Math.max(maxFechaX, sorted[i].x, next!.x);
      i++; // consume next token
    }
  }

  return { tokens: out, maxX: maxFechaX };
}

export async function extractBCPByColumns(
  pdfBuffer: ArrayBuffer
): Promise<ExtractBCPResult> {
  // pdfjs-dist is only needed on server side.
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await pdfjsLib
    .getDocument({ data: pdfBuffer, disableWorker: true })
    .promise;

  const allTransactions: ParsedTransaction[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items as Array<any>;

    // Determine column anchors for Debe/Haber using header labels.
    let debitAnchorX: number | null = null;
    let creditAnchorX: number | null = null;

    for (const it of items) {
      const str = (it.str ?? '').toString();
      const transform = it.transform as number[];
      const x = transform?.[4];
      if (typeof x !== 'number') continue;
      const upper = str.toUpperCase();
      if (!debitAnchorX && (upper.includes('DEBE') || upper.includes('CARGOS'))) {
        debitAnchorX = x;
      }
      if (!creditAnchorX && (upper.includes('HABER') || upper.includes('ABONOS'))) {
        creditAnchorX = x;
      }
    }

    // If we can't identify the anchors, skip this page.
    if (debitAnchorX === null || creditAnchorX === null) continue;

    const colTol = 20; // x tolerance in PDF units
    const rowTol = 6; // y tolerance in PDF units

    // Cluster items into rows by y position.
    // pdfjs y grows upwards; for clustering it's fine to use raw y.
    const rows: Array<{ y: number; items: Array<any>; }> = [];

    for (const it of items) {
      const str = (it.str ?? '').toString();
      if (!str.trim()) continue;
      const transform = it.transform as number[];
      const x = transform?.[4];
      const y = transform?.[5];
      if (typeof x !== 'number' || typeof y !== 'number') continue;

      const row = rows.find((r) => Math.abs(r.y - y) <= rowTol);
      const itemWithPos = { ...it, x, y, str };
      if (row) {
        row.items.push(itemWithPos);
        // Update representative y for robustness
        row.y = (row.y * (row.items.length - 1) + y) / row.items.length;
      } else {
        rows.push({ y, items: [itemWithPos] });
      }
    }

    // Sort rows top-to-bottom by y descending (heuristic).
    rows.sort((a, b) => b.y - a.y);

    for (const r of rows) {
      const rowItems = r.items;

      // Find amounts in the Debe and Haber column ranges.
      const debitCandidates = rowItems
        .filter((it) => Math.abs(it.x - debitAnchorX!) <= colTol && isAmountToken(it.str))
        .sort((a, b) => a.x - b.x);
      const creditCandidates = rowItems
        .filter((it) => Math.abs(it.x - creditAnchorX!) <= colTol && isAmountToken(it.str))
        .sort((a, b) => a.x - b.x);

      if (debitCandidates.length === 0 && creditCandidates.length === 0) continue;

      // Extract fechaProc/fechaValor as the first two fecha tokens from the left.
      const { tokens: fechaTokens, maxX: maxFechaX } = extractFechaTokens(
        rowItems
      );
      if (fechaTokens.length < 1) continue;

      const fechaProc = fechaTokens[0];
      const fechaValor = fechaTokens[1] ?? fechaTokens[0];

      // Amounts: keep raw tokens from PDF (clean later by parser/formatter).
      const debit = debitCandidates.length > 0 ? debitCandidates[debitCandidates.length - 1].str : '0';
      const credit = creditCandidates.length > 0 ? creditCandidates[creditCandidates.length - 1].str : '0';

      // Description: join tokens excluding fechas and excluding amount tokens near anchors.
      const dateTokensSet = new Set(fechaTokens);
      const debitXSet = new Set(debitCandidates.map((c) => c.str));
      const creditXSet = new Set(creditCandidates.map((c) => c.str));

      const descTokens = rowItems
        .sort((a, b) => a.x - b.x)
        .filter((it) => {
          const upper = it.str.toUpperCase();
          // Remove fecha tokens area (day/month tokens sometimes come split)
          if (it.x <= maxFechaX + 0.5) return false;
          if (dateTokensSet.has(it.str)) return false;
          // Filter out the amount tokens themselves (by matching numeric candidates)
          if (isAmountToken(it.str) && (debitXSet.has(it.str) || creditXSet.has(it.str))) return false;
          // Avoid header/footer noise
          if (upper.includes('SALDO') && upper.length <= 8) return false;
          if (upper.includes('MENSAJE') || upper.includes('CLIENTE')) return false;
          return true;
        })
        .map((it) => it.str.trim())
        .filter(Boolean);

      const description = descTokens.join(' ');

      // Skip the row if it looks like header noise
      if (!description.trim()) continue;

      allTransactions.push({
        fechaProc,
        fechaValor,
        description,
        debit,
        credit,
        raw: '',
      });
    }
  }

  return allTransactions;
}

