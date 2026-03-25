import * as XLSX from 'xlsx'

export type SheetTable = {
  headers: string[]
  rows: Record<string, unknown>[]
}

function headerLabel(raw: unknown, index: number): string {
  const s = String(raw ?? '').trim()
  return s || `Columna_${index + 1}`
}

/** First row = headers; remaining rows = data objects keyed by header. */
export function sheetToTable(sheet: XLSX.WorkSheet): SheetTable {
  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  }) as unknown[][]

  if (!matrix.length) {
    return { headers: [], rows: [] }
  }

  const headerRow = matrix[0] as unknown[]
  const headers = headerRow.map((cell, i) => headerLabel(cell, i))

  const rows: Record<string, unknown>[] = []
  for (let r = 1; r < matrix.length; r++) {
    const line = matrix[r] as unknown[]
    const row: Record<string, unknown> = {}
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = line?.[c]
    }
    rows.push(row)
  }

  return { headers, rows }
}

export function readWorkbookNames(buffer: ArrayBuffer): string[] {
  const wb = XLSX.read(buffer, { type: 'array' })
  return wb.SheetNames
}

export function readSheetTable(buffer: ArrayBuffer, sheetName: string): SheetTable {
  const wb = XLSX.read(buffer, { type: 'array' })
  const sheet = wb.Sheets[sheetName]
  if (!sheet) {
    return { headers: [], rows: [] }
  }
  return sheetToTable(sheet)
}

export function buildWorkbookDownload(
  headers: string[],
  rows: Record<string, string | number | boolean | null>[],
): Uint8Array {
  const aoa: (string | number | boolean | null)[][] = [headers]
  for (const row of rows) {
    aoa.push(headers.map((h) => row[h] ?? ''))
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Resultado')
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array
  return out
}
