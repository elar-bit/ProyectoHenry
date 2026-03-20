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

    const dayOk = /^\d{1,2}$/.test(str);
    if (!dayOk) continue;
    const next = sorted[i + 1];
    if (!next) continue;
    const nextStr = (next.str ?? '').toString().trim();
    const split = parseFechaTokenFromSplit(str, nextStr);
    if (split) {
      out.push(split);
      maxFechaX = Math.max(maxFechaX, sorted[i].x, next.x);
      i++;
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

    // Determine amount column clusters (left vs right) using layout positions.
    const amountXs: number[] = [];
    for (const it of items) {
      const str = (it.str ?? '').toString().trim();
      const x = (it.transform as number[] | undefined)?.[4];
      const y = (it.transform as number[] | undefined)?.[5];
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      if (!str) continue;
      if (!str.includes('.')) continue;
      if (!isAmountToken(str)) continue;
      // movement table area only
      if (y < 250 || y > 600) continue;
      amountXs.push(x);
    }

    if (amountXs.length < 5) continue;

    let c1 = Math.min(...amountXs);
    let c2 = Math.max(...amountXs);
    for (let iter = 0; iter < 8; iter++) {
      const cluster1: number[] = [];
      const cluster2: number[] = [];
      for (const x of amountXs) {
        if (Math.abs(x - c1) <= Math.abs(x - c2)) cluster1.push(x);
        else cluster2.push(x);
      }
      if (cluster1.length === 0 || cluster2.length === 0) break;
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const nc1 = mean(cluster1);
      const nc2 = mean(cluster2);
      if (Math.abs(nc1 - c1) < 0.01 && Math.abs(nc2 - c2) < 0.01) break;
      c1 = nc1;
      c2 = nc2;
    }

    const leftCenter = Math.min(c1, c2);
    const rightCenter = Math.max(c1, c2);
    let debitCenter = leftCenter;
    let creditCenter = rightCenter;

    if (debitAnchorX !== null && creditAnchorX !== null) {
      const distLeftToDebe = Math.abs(leftCenter - debitAnchorX);
      const distRightToDebe = Math.abs(rightCenter - debitAnchorX);
      debitCenter = distLeftToDebe <= distRightToDebe ? leftCenter : rightCenter;
      creditCenter = debitCenter === leftCenter ? rightCenter : leftCenter;
    }

    for (const r of rows) {
      const rowItems = r.items;
      const amountCandidates = rowItems
        .filter((it) => {
          const str = (it.str ?? '').toString().trim();
          return str.includes('.') && isAmountToken(str);
        })
        .sort((a, b) => b.x - a.x);
      if (amountCandidates.length === 0) continue;

      const { tokens: fechaTokens, maxX: maxFechaX } = extractFechaTokens(
        rowItems
      );
      if (fechaTokens.length < 1) continue;

      const fechaProc = fechaTokens[0];
      const fechaValor = fechaTokens[1] ?? fechaTokens[0];

      const amountToken = amountCandidates[0];
      const amount = (amountToken.str ?? '').toString().trim();
      const amountX = amountToken.x as number;

      const distToDeb = Math.abs(amountX - debitCenter);
      const distToCre = Math.abs(amountX - creditCenter);
      const debit = distToDeb <= distToCre ? amount : '0';
      const credit = distToCre < distToDeb ? amount : '0';

      const description = rowItems
        .sort((a, b) => a.x - b.x)
        .filter((it) => {
          const s = (it.str ?? '').toString().trim();
          const upper = s.toUpperCase();
          if (!s) return false;
          if (it.x <= maxFechaX + 0.5) return false;
          if (s.includes('.') && isAmountToken(s)) return false;
          if (upper.includes('SALDO') && upper.length <= 8) return false;
          if (upper.includes('MENSAJE') || upper.includes('CLIENTE')) return false;
          return true;
        })
        .map((it) => (it.str ?? '').toString().trim())
        .filter(Boolean)
        .join(' ');

      // Skip the row if it looks like header noise
      if (!description.trim()) continue;
      if (debit === '0' && credit === '0') continue;

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

