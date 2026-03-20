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

    // Determine column anchors from header labels (layout-based parsing).
    let procAnchorX: number | null = null;
    let valorAnchorX: number | null = null;
    let descAnchorX: number | null = null;
    let debitAnchorX: number | null = null;
    let creditAnchorX: number | null = null;

    for (const it of items) {
      const str = (it.str ?? '').toString();
      const transform = it.transform as number[];
      const x = transform?.[4];
      if (typeof x !== 'number') continue;
      const upper = str.toUpperCase();
      if (!procAnchorX && (upper.includes('PROC') || upper === 'PROC.')) {
        procAnchorX = x;
      }
      if (!valorAnchorX && upper.includes('VALOR')) {
        valorAnchorX = x;
      }
      if (!descAnchorX && upper.includes('DESCRIPCION')) {
        descAnchorX = x;
      }
      if (!debitAnchorX && (upper.includes('DEBE') || upper.includes('CARGOS'))) {
        debitAnchorX = x;
      }
      if (!creditAnchorX && (upper.includes('HABER') || upper.includes('ABONOS'))) {
        creditAnchorX = x;
      }
    }

    // Need at least 5 anchors to build column boundaries.
    if (
      procAnchorX === null ||
      valorAnchorX === null ||
      descAnchorX === null ||
      debitAnchorX === null ||
      creditAnchorX === null
    ) {
      continue;
    }

    // Column boundaries = midpoints between adjacent header anchors.
    // This behaves like the vertical separators in the statement layout.
    const b1 = -Infinity;
    const b2 = (procAnchorX + valorAnchorX) / 2;
    const b3 = (valorAnchorX + descAnchorX) / 2;
    const b4 = (descAnchorX + debitAnchorX) / 2;
    const b5 = (debitAnchorX + creditAnchorX) / 2;
    const b6 = Infinity;

    const colForX = (x: number): 1 | 2 | 3 | 4 | 5 => {
      if (x >= b1 && x < b2) return 1;
      if (x >= b2 && x < b3) return 2;
      if (x >= b3 && x < b4) return 3;
      if (x >= b4 && x < b5) return 4;
      return 5;
    };

    const parseFechaFromColTokens = (tokens: string[]): string | null => {
      if (!tokens.length) return null;
      // Prefer combined token like 02FEB
      for (const t of tokens) {
        const combined = parseFechaTokenFromCombined(t);
        if (combined) return combined;
      }
      // Fallback split token: "02" + "FEB"
      for (let i = 0; i < tokens.length - 1; i++) {
        const split = parseFechaTokenFromSplit(tokens[i], tokens[i + 1]);
        if (split) return split;
      }
      return null;
    };

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

      const col1 = rowItems
        .filter((it) => colForX(it.x) === 1)
        .sort((a, b) => a.x - b.x)
        .map((it) => (it.str ?? '').toString().trim())
        .filter(Boolean);
      const col2 = rowItems
        .filter((it) => colForX(it.x) === 2)
        .sort((a, b) => a.x - b.x)
        .map((it) => (it.str ?? '').toString().trim())
        .filter(Boolean);
      const col3Items = rowItems
        .filter((it) => colForX(it.x) === 3)
        .sort((a, b) => a.x - b.x);
      const col4Items = rowItems
        .filter((it) => colForX(it.x) === 4)
        .sort((a, b) => a.x - b.x);
      const col5Items = rowItems
        .filter((it) => colForX(it.x) === 5)
        .sort((a, b) => a.x - b.x);

      const fechaProc = parseFechaFromColTokens(col1);
      const fechaValor = parseFechaFromColTokens(col2) ?? fechaProc;
      if (!fechaProc) continue;

      const debitCandidates = col4Items
        .map((it) => (it.str ?? '').toString().trim())
        .filter((s) => s.includes('.') && isAmountToken(s));
      const creditCandidates = col5Items
        .map((it) => (it.str ?? '').toString().trim())
        .filter((s) => s.includes('.') && isAmountToken(s));

      // Description comes from the description column only.
      const description = col3Items
        .map((it) => (it.str ?? '').toString().trim())
        .filter(Boolean)
        .join(' ');

      const debit =
        debitCandidates.length > 0
          ? debitCandidates[debitCandidates.length - 1]
          : '0';
      const credit =
        creditCandidates.length > 0
          ? creditCandidates[creditCandidates.length - 1]
          : '0';

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

