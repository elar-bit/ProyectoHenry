import type { ParsedTransaction } from '@/lib/pdf-processor';

type SaldoToken = {
  y: number;
  date: string;
  saldo: number;
};

function isDateProcToken(s: string) {
  return /^\d{1,2}-\d{1,2}$/.test(s.trim());
}

function isTimeToken(s: string) {
  return /^\d{1,2}:\d{2}$/.test(s.trim());
}

function isMoneyToken(s: string) {
  const t = s.trim();
  // Examples: 23.00, 5,343.68, 1.00-, 1,000.00-
  return (
    /^-?\d{1,3}(?:,\d{3})*\.\d{2}-?$/.test(t) ||
    /^-?\d[\d,]*\.\d{2}-?$/.test(t) ||
    /^-?\d+\.\d{2}-?$/.test(t)
  );
}

function parseMoneyToken(s: string) {
  let t = s.trim();
  let isNegative = false;
  if (t.endsWith('-')) {
    isNegative = true;
    t = t.slice(0, -1);
  }
  // remove thousands separators
  t = t.replace(/,/g, '');
  const v = parseFloat(t);
  if (Number.isNaN(v)) return 0;
  return isNegative ? -v : v;
}

function groupRows(tokens: Array<{ x: number; y: number; str: string }>, tol = 4) {
  const rows: Array<{ y: number; items: Array<{ x: number; y: number; str: string }> }> =
    [];
  for (const t of tokens) {
    let row = rows.find((r) => Math.abs(r.y - t.y) <= tol);
    if (!row) {
      row = { y: t.y, items: [t] };
      rows.push(row);
    } else {
      row.items.push(t);
      row.y = (row.y * (row.items.length - 1) + t.y) / row.items.length;
    }
  }
  // pdfjs y grows upwards; top of page usually higher y -> sort desc
  rows.sort((a, b) => b.y - a.y);
  return rows;
}

export async function extractCorrientesSaldoContableByRows(
  pdfBuffer: ArrayBuffer,
  expectedRows?: number
): Promise<number[]> {
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Preload the worker message handler if possible to avoid fake-worker issues.
  try {
    const g = globalThis as any;
    if (!g.pdfjsWorker?.WorkerMessageHandler) {
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      g.pdfjsWorker = worker;
    }
  } catch {
    // ignore
  }

  const doc = await pdfjsLib
    .getDocument({
      data: new Uint8Array(pdfBuffer),
      disableWorker: true,
      isEvalSupported: true,
      useWorkerFetch: false,
    })
    .promise;

  const out: SaldoToken[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items as Array<any>;

    const tokens: Array<{ x: number; y: number; str: string }> = [];
    for (const it of items) {
      const str = (it.str ?? '').toString();
      if (!str.trim()) continue;
      const transform = it.transform as number[];
      const x = transform?.[4];
      const y = transform?.[5];
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      tokens.push({ x, y, str });
    }

    const rows = groupRows(tokens, 4);

    for (const row of rows) {
      const hasDate = row.items.some((t) => isDateProcToken(t.str));
      const hasTime = row.items.some((t) => isTimeToken(t.str));
      const upperRow = row.items.map((t) => t.str.toUpperCase()).join(' ');
      const hasKeyword =
        /(PAGO|IMPUESTO|DEPOSITO|RET\.?|TRAN\.?|ACTIVIDAD|OPERACI|OPE\.?)/i.test(
          upperRow
        );

      const moneyTokens = row.items
        .filter((t) => isMoneyToken(t.str))
        .sort((a, b) => a.x - b.x);
      if (moneyTokens.length === 0) continue;

      // Aunque el OCR no incluya fecha en esa fila, si contiene hora o
      // keywords típicas, igual consideramos que es parte de una transacción.
      if (!hasDate && !hasTime && !hasKeyword) continue;

      const right = moneyTokens[moneyTokens.length - 1];

      out.push({
        y: row.y,
        date: '', // no requerido para el mapping por índice
        saldo: parseMoneyToken(right.str),
      });

      if (expectedRows && out.length >= expectedRows) break;
    }

    if (expectedRows && out.length >= expectedRows) break;
  }

  // out already in top->bottom order due to row sorting.
  return out.slice(0, expectedRows ?? out.length).map((t) => t.saldo);
}

