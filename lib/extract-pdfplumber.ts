import { spawnSync } from 'child_process';
import path from 'path';
import type { ParsedTransaction } from '@/lib/pdf-processor';

type PdfPlumberPayload = { transactions: ParsedTransaction[]; error?: string };

function parseJsonFromOutput(raw: string): PdfPlumberPayload | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as PdfPlumberPayload;
  } catch {
    const nl = text.lastIndexOf('\n');
    const lastLine = nl >= 0 ? text.slice(nl + 1).trim() : text;
    try {
      return JSON.parse(lastLine) as PdfPlumberPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Extrae movimientos usando pdfplumber (Python).
 * Requiere: `python3` en PATH y `pip install -r requirements.txt`.
 * Si falla (entorno sin Python, deps, etc.), devuelve null para usar el fallback TS.
 */
export function extractWithPdfPlumber(
  pdfBuffer: ArrayBuffer
): ParsedTransaction[] | null {
  const scriptPath = path.join(process.cwd(), 'python', 'bcp_extract.py');
  const buf = Buffer.from(pdfBuffer);

  const tryPython = (cmd: string) =>
    spawnSync(cmd, [scriptPath], {
      input: buf,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf-8',
      windowsHide: true,
    });

  let result = tryPython('python3');
  if (result.error || result.status !== 0) {
    result = tryPython('python');
  }

  if (result.error) {
    return null;
  }
  if (result.status !== 0 && result.status !== null) {
    return null;
  }

  const parsed = parseJsonFromOutput(result.stdout || '');
  if (!parsed || parsed.error) {
    return null;
  }
  if (!Array.isArray(parsed.transactions)) {
    return null;
  }

  return parsed.transactions;
}
