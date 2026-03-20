import type { ParsedTransaction } from '@/lib/pdf-processor';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

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
  // dot-decimal (US-ish): 1,234.56 / 686.00 / .85-
  const dotDecimal =
    /^-?\d[\d,]*([.]\d+)?-?$/.test(s) || /^[\d,]+\.\d+-?$/.test(s);
  // comma-decimal (LATAM): 500,00 / 1.234,56 / 1,234,56 (rare OCR)
  const commaDecimal =
    /^-?\d+,\d{1,2}-?$/.test(s) ||
    /^-?\d{1,3}(?:\.\d{3})+,\d{1,2}-?$/.test(s);
  return dotDecimal || commaDecimal;
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
  // In serverless/Next chunks, resolving worker paths via `eval('require')`
  // can fail. Use createRequire so `pdfjs-dist` can load the worker file.
  let workerUrl: string | undefined;
  try {
    // Resolve from this module, independent of runtime cwd.
    const req = createRequire(import.meta.url);
    const workerPath = req.resolve(
      'pdfjs-dist/legacy/build/pdf.worker.mjs'
    ) as string;

    // pdfjs fake-worker does: `import(this.workerSrc)` (see _setupFakeWorkerGlobal)
    // so provide a real file:// URL.
    workerUrl = pathToFileURL(workerPath).href;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  } catch {
    // If resolution fails, pdfjs will fall back to its own defaults.
  }

  const doc = await pdfjsLib
    .getDocument({
      data: new Uint8Array(pdfBuffer),
      // Use the fake worker path, but with a valid `workerSrc` import target.
      disableWorker: true,
      // When eval is available, pdfjs can avoid the fake-worker path that
      // breaks on serverless bundles (/var/task/.next/server/chunks/...).
      // In serverless Node environments, eval is typically supported.
      isEvalSupported: true,
      useWorkerFetch: false,
      ...(workerUrl ? { workerSrc: workerUrl } : {}),
    })
    .promise;

  const allTransactions: ParsedTransaction[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const items = textContent.items as Array<any>;

    // Centros X de encabezados CARGOS/DEBE y ABONOS/HABER (promedio de todos los tokens).
    const debeCenters: number[] = [];
    const haberCenters: number[] = [];

    for (const it of items) {
      const str = (it.str ?? '').toString();
      const transform = it.transform as number[];
      const x = transform?.[4];
      if (typeof x !== 'number') continue;
      const w =
        typeof (it as { width?: number }).width === 'number'
          ? (it as { width: number }).width
          : str.length * 4.5;
      const cx = x + w / 2;
      const upper = str.toUpperCase();
      const isDebe =
        /\b(DEBE|CARGOS)\b/.test(upper) ||
        upper === 'DEBE' ||
        upper === 'CARGOS';
      const isHaber =
        /\b(HABER|ABONOS)\b/.test(upper) ||
        upper === 'HABER' ||
        upper === 'ABONOS';
      if (isDebe) debeCenters.push(cx);
      if (isHaber) haberCenters.push(cx);
    }

    const debitAnchorX =
      debeCenters.length > 0
        ? debeCenters.reduce((a, b) => a + b, 0) / debeCenters.length
        : null;
    const creditAnchorX =
      haberCenters.length > 0
        ? haberCenters.reduce((a, b) => a + b, 0) / haberCenters.length
        : null;

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

    // Frontera entre Cargos (izquierda) y Abonos (derecha) según encabezados.
    let boundary: number | null = null;
    if (debitAnchorX !== null && creditAnchorX !== null) {
      const lo = Math.min(debitAnchorX, creditAnchorX);
      const hi = Math.max(debitAnchorX, creditAnchorX);
      boundary = (lo + hi) / 2;
    } else {
      continue;
    }

    for (const r of rows) {
      const rowItems = r.items;
      const amountCandidates = rowItems
        .filter((it) => {
          const str = (it.str ?? '').toString().trim();
          return isAmountToken(str);
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
      const w =
        typeof (amountToken as { width?: number }).width === 'number'
          ? (amountToken as { width: number }).width
          : amount.length * 4.5;
      const amountCx = (amountToken.x as number) + w / 2;

      const debit =
        boundary !== null && amountCx < boundary ? amount : '0';
      const credit =
        boundary !== null && amountCx >= boundary ? amount : '0';

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

