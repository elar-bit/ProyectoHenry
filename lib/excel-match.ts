export const NO_DATA = 'Sin Datos'

export function normalizeMatchKey(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return String(value).trim()
  }
  return String(value).trim()
}

export type MatchCandidate = Record<string, string>

export type RowMatchState =
  | { kind: 'none' }
  | { kind: 'single'; values: Record<string, string> }
  | { kind: 'ambiguous'; candidates: MatchCandidate[]; selectedIndex: number }

export function buildMatchIndex(
  rows2: Record<string, unknown>[],
  colMatch2: string,
): Map<string, number[]> {
  const map = new Map<string, number[]>()
  rows2.forEach((row, i) => {
    const key = normalizeMatchKey(row[colMatch2])
    if (!key) return
    const list = map.get(key)
    if (list) list.push(i)
    else map.set(key, [i])
  })
  return map
}

export function rowValuesFromSheet2(
  row2: Record<string, unknown>,
  copyCols: string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of copyCols) {
    const v = row2[c]
    const s = normalizeMatchKey(v)
    out[c] = s || NO_DATA
  }
  return out
}

export function computeRowMatches(
  rows1: Record<string, unknown>[],
  colMatch1: string,
  rows2: Record<string, unknown>[],
  colMatch2: string,
  copyCols: string[],
): RowMatchState[] {
  const index2 = buildMatchIndex(rows2, colMatch2)

  return rows1.map((row1) => {
    const key = normalizeMatchKey(row1[colMatch1])
    if (!key) {
      return { kind: 'none' as const }
    }
    const indices = index2.get(key)
    if (!indices || indices.length === 0) {
      return { kind: 'none' as const }
    }
    if (indices.length === 1) {
      const values = rowValuesFromSheet2(rows2[indices[0]], copyCols)
      return { kind: 'single' as const, values }
    }
    const candidates: MatchCandidate[] = indices.map((idx) => {
      const r2 = rows2[idx]
      const o: MatchCandidate = {}
      for (const c of copyCols) {
        o[c] = normalizeMatchKey(r2[c]) || NO_DATA
      }
      return o
    })
    return {
      kind: 'ambiguous' as const,
      candidates,
      selectedIndex: 0,
    }
  })
}

export function resolveRowValue(
  state: RowMatchState,
  copyCol: string,
): string {
  if (state.kind === 'none') return NO_DATA
  if (state.kind === 'single') return state.values[copyCol] ?? NO_DATA
  const cand = state.candidates[state.selectedIndex]
  return cand?.[copyCol] ?? NO_DATA
}

/** Evita colisiones de nombre entre columnas del Excel 1 y las copiadas del Excel 2. */
export function planOutputHeaders(
  sheet1Headers: string[],
  copyColsFromSheet2: string[],
): Record<string, string> {
  const used = new Set(sheet1Headers)
  const finalBySheet2: Record<string, string> = {}
  for (const c of copyColsFromSheet2) {
    let name = c
    if (used.has(name)) {
      name = `${c} (Excel 2)`
      let i = 2
      while (used.has(name)) {
        name = `${c} (Excel 2) ${i}`
        i++
      }
    }
    used.add(name)
    finalBySheet2[c] = name
  }
  return finalBySheet2
}
