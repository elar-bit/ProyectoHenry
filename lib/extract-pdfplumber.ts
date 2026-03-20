import { spawnSync } from 'child_process';
import path from 'path';
import type { ParsedTransaction } from '@/lib/pdf-processor';
import fs from 'fs';

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
): ParsedTransaction[] {
  const candidates: string[] = [
    path.join(process.cwd(), 'python', 'bcp_extract.py'),
  ];
  // __dirname puede no estar definido si el runtime compila como ESM.
  try {
    // eslint-disable-next-line no-undef
    if (typeof __dirname === 'string') {
      // eslint-disable-next-line no-undef
      candidates.push(path.join(__dirname, '..', 'python', 'bcp_extract.py'));
    }
  } catch {
    // ignore
  }

  const scriptPath =
    candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }) || candidates[0];

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
    throw new Error(
      `pdfplumber: failed to start python (${result.error.message})`
    );
  }
  if (result.status !== 0 && result.status !== null) {
    throw new Error(
      `pdfplumber: script exit status ${String(result.status)}`
    );
  }

  const parsed = parseJsonFromOutput(result.stdout || '');
  if (!parsed || parsed.error) {
    throw new Error(
      `pdfplumber: invalid output${parsed?.error ? ` (${parsed.error})` : ''}`
    );
  }
  if (!Array.isArray(parsed.transactions)) {
    throw new Error('pdfplumber: transactions missing/invalid');
  }

  return parsed.transactions;
}
