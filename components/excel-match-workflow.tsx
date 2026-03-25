'use client'

import { useCallback, useMemo, useState } from 'react'
import {
  computeRowMatches,
  planOutputHeaders,
  resolveRowValue,
  type RowMatchState,
} from '@/lib/excel-match'
import {
  buildWorkbookDownload,
  readSheetTable,
  readWorkbookNames,
  type SheetTable,
} from '@/lib/excel-parse'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

type Step = 1 | 2 | 3 | 4

function candidateLabel(c: Record<string, string>, copyCols: string[]): string {
  return copyCols.map((cname) => `${cname}: ${c[cname] ?? ''}`).join(' · ')
}

/** Más ancho para columnas típicas de identificación (RUC, DNI, etc.). */
function isRucOrDniHeader(label: string): boolean {
  const s = label.toLowerCase()
  return (
    s.includes('ruc') ||
    s.includes('dni') ||
    s.includes('cédula') ||
    s.includes('cedula')
  )
}

const selectTriggerWideClass =
  'h-auto min-h-10 w-full whitespace-normal text-left [&_[data-slot=select-value]]:line-clamp-none [&_[data-slot=select-value]]:whitespace-normal'

export default function ExcelMatchWorkflow() {
  const [step, setStep] = useState<Step>(1)

  const [buf1, setBuf1] = useState<ArrayBuffer | null>(null)
  const [name1, setName1] = useState('')
  const [sheets1, setSheets1] = useState<string[]>([])
  const [sheet1, setSheet1] = useState('')
  const [table1, setTable1] = useState<SheetTable | null>(null)

  const [buf2, setBuf2] = useState<ArrayBuffer | null>(null)
  const [name2, setName2] = useState('')
  const [sheets2, setSheets2] = useState<string[]>([])
  const [sheet2, setSheet2] = useState('')
  const [table2, setTable2] = useState<SheetTable | null>(null)

  const [matchCol1, setMatchCol1] = useState('')
  const [matchCol2, setMatchCol2] = useState('')
  const [copyCols, setCopyCols] = useState<string[]>([])

  const [matchStates, setMatchStates] = useState<RowMatchState[] | null>(null)

  const loadFile1 = useCallback(async (file: File | null) => {
    if (!file) {
      setBuf1(null)
      setName1('')
      setSheets1([])
      setSheet1('')
      setTable1(null)
      setMatchStates(null)
      return
    }
    const ab = await file.arrayBuffer()
    setBuf1(ab)
    setName1(file.name)
    const names = readWorkbookNames(ab)
    setSheets1(names)
    const first = names[0] ?? ''
    setSheet1(first)
    setTable1(first ? readSheetTable(ab, first) : null)
    setMatchStates(null)
    setMatchCol1('')
    setCopyCols([])
  }, [])

  const loadFile2 = useCallback(async (file: File | null) => {
    if (!file) {
      setBuf2(null)
      setName2('')
      setSheets2([])
      setSheet2('')
      setTable2(null)
      setMatchStates(null)
      return
    }
    const ab = await file.arrayBuffer()
    setBuf2(ab)
    setName2(file.name)
    const names = readWorkbookNames(ab)
    setSheets2(names)
    const first = names[0] ?? ''
    setSheet2(first)
    setTable2(first ? readSheetTable(ab, first) : null)
    setMatchStates(null)
    setMatchCol2('')
  }, [])

  const onSheet1Change = useCallback(
    (sn: string) => {
      if (!buf1) return
      setSheet1(sn)
      setTable1(readSheetTable(buf1, sn))
      setMatchStates(null)
      setMatchCol1('')
    },
    [buf1],
  )

  const onSheet2Change = useCallback((sn: string) => {
    if (!buf2) return
    setSheet2(sn)
    const t = readSheetTable(buf2, sn)
    setTable2(t)
    setMatchStates(null)
    setMatchCol2('')
    setCopyCols((prev) => prev.filter((c) => t.headers.includes(c)))
  }, [buf2])

  const toggleCopyCol = useCallback((col: string, checked: boolean) => {
    setCopyCols((prev) => {
      if (checked) return prev.includes(col) ? prev : [...prev, col]
      return prev.filter((c) => c !== col)
    })
    setMatchStates(null)
  }, [])

  const finalBySheet2 = useMemo(() => {
    if (!table1 || !copyCols.length) return {}
    return planOutputHeaders(table1.headers, copyCols)
  }, [table1, copyCols])

  const runMatch = useCallback(() => {
    if (!table1 || !table2 || !matchCol1 || !matchCol2 || copyCols.length === 0)
      return
    const states = computeRowMatches(
      table1.rows,
      matchCol1,
      table2.rows,
      matchCol2,
      copyCols,
    )
    setMatchStates(states)
    setStep(4)
  }, [table1, table2, matchCol1, matchCol2, copyCols])

  const setAmbiguousSelection = useCallback((rowIndex: number, selectedIndex: number) => {
    setMatchStates((prev) => {
      if (!prev) return prev
      const next = [...prev]
      const s = next[rowIndex]
      if (s?.kind !== 'ambiguous') return prev
      next[rowIndex] = { ...s, selectedIndex }
      return next
    })
  }, [])

  const exportRows = useMemo(() => {
    if (!table1 || !matchStates || !copyCols.length) return null
    return table1.rows.map((row, i) => {
      const st = matchStates[i]
      const out: Record<string, string | number | boolean | null> = {}
      for (const h of table1.headers) {
        const v = row[h]
        out[h] =
          v === null || v === undefined
            ? ''
            : typeof v === 'object'
              ? String(v)
              : (v as string | number | boolean)
      }
      for (const c2 of copyCols) {
        const headerOut = finalBySheet2[c2] ?? c2
        out[headerOut] = st
          ? resolveRowValue(st, c2)
          : 'Sin Datos'
      }
      return out
    })
  }, [table1, matchStates, copyCols, finalBySheet2])

  const downloadXlsx = useCallback(() => {
    if (!table1 || !exportRows) return
    const extraHeaders = copyCols.map((c) => finalBySheet2[c] ?? c)
    const headers = [...table1.headers, ...extraHeaders]
    const bytes = buildWorkbookDownload(headers, exportRows)
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'resultado_coincidencias.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }, [table1, exportRows, copyCols, finalBySheet2])

  const resetAll = useCallback(() => {
    setStep(1)
    setBuf1(null)
    setName1('')
    setSheets1([])
    setSheet1('')
    setTable1(null)
    setBuf2(null)
    setName2('')
    setSheets2([])
    setSheet2('')
    setTable2(null)
    setMatchCol1('')
    setMatchCol2('')
    setCopyCols([])
    setMatchStates(null)
  }, [])

  const canProceedStep1 = Boolean(table1?.headers.length)
  const canProceedStep2 = Boolean(table2?.headers.length)
  const canRunMatch =
    Boolean(
      matchCol1 &&
        matchCol2 &&
        copyCols.length > 0 &&
        table1 &&
        table2,
    )

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Paso 1 — Hoja de Excel 1 (base)</CardTitle>
          <CardDescription>
            Archivo principal: aquí se añadirán las columnas traídas del Excel 2.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="mb-2 block">Archivo (.xlsx)</Label>
            <input
              type="file"
              accept=".xlsx,.xlsm"
              className="block w-full text-sm text-slate-600 file:mr-4 file:rounded-md file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                void loadFile1(f)
              }}
            />
            {name1 ? (
              <p className="mt-2 text-sm text-slate-600">Cargado: {name1}</p>
            ) : null}
          </div>
          {sheets1.length > 1 ? (
            <div className="space-y-2">
              <Label>Hoja</Label>
              <Select value={sheet1} onValueChange={onSheet1Change}>
                <SelectTrigger className="w-full max-w-md">
                  <SelectValue placeholder="Seleccione hoja" />
                </SelectTrigger>
                <SelectContent>
                  {sheets1.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {table1 && table1.headers.length > 0 ? (
            <p className="text-sm text-slate-600">
              Columnas detectadas:{' '}
              <span className="font-medium text-slate-900">
                {table1.headers.join(', ')}
              </span>{' '}
              ({table1.rows.length} filas)
            </p>
          ) : null}
          <Button
            type="button"
            disabled={!canProceedStep1}
            onClick={() => setStep(2)}
          >
            Continuar al Excel 2
          </Button>
        </CardContent>
      </Card>

      {step >= 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>Paso 2 — Hoja de Excel 2 (consulta)</CardTitle>
            <CardDescription>
              Archivo donde se buscarán coincidencias y de donde se copiarán datos.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="mb-2 block">Archivo (.xlsx)</Label>
              <input
                type="file"
                accept=".xlsx,.xlsm"
                className="block w-full text-sm text-slate-600 file:mr-4 file:rounded-md file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  void loadFile2(f)
                }}
              />
              {name2 ? (
                <p className="mt-2 text-sm text-slate-600">Cargado: {name2}</p>
              ) : null}
            </div>
            {sheets2.length > 1 ? (
              <div className="space-y-2">
                <Label>Hoja</Label>
                <Select value={sheet2} onValueChange={onSheet2Change}>
                  <SelectTrigger className="w-full max-w-md">
                    <SelectValue placeholder="Seleccione hoja" />
                  </SelectTrigger>
                  <SelectContent>
                    {sheets2.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {table2 && table2.headers.length > 0 ? (
              <p className="text-sm text-slate-600">
                Columnas detectadas:{' '}
                <span className="font-medium text-slate-900">
                  {table2.headers.join(', ')}
                </span>{' '}
                ({table2.rows.length} filas)
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep(1)}
              >
                Volver
              </Button>
              <Button
                type="button"
                disabled={!canProceedStep2}
                onClick={() => setStep(3)}
              >
                Continuar al mapeo
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step >= 3 ? (
        <Card>
          <CardHeader>
            <CardTitle>Paso 3 — Coincidencia y columnas a copiar</CardTitle>
            <CardDescription>
              Elija en qué columnas comparar valores y qué columnas del Excel 2
              desea agregar al Excel 1 cuando haya coincidencia.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Columna de coincidencia en Excel 1</Label>
                <Select
                  value={matchCol1 || undefined}
                  onValueChange={(v) => {
                    setMatchCol1(v)
                    setMatchStates(null)
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Seleccione columna" />
                  </SelectTrigger>
                  <SelectContent>
                    {(table1?.headers ?? []).map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Columna de coincidencia en Excel 2</Label>
                <Select
                  value={matchCol2 || undefined}
                  onValueChange={(v) => {
                    setMatchCol2(v)
                    setMatchStates(null)
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Seleccione columna" />
                  </SelectTrigger>
                  <SelectContent>
                    {(table2?.headers ?? []).map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              <Label>Columnas del Excel 2 a agregar al Excel 1</Label>
              <p className="text-sm text-muted-foreground">
                Marque las columnas que desea traer (por ejemplo Factura y RUC).
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(table2?.headers ?? []).map((h) => (
                  <label
                    key={h}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-xs',
                    )}
                  >
                    <Checkbox
                      checked={copyCols.includes(h)}
                      onCheckedChange={(c) => toggleCopyCol(h, c === true)}
                    />
                    <span>{h}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(2)}>
                Volver
              </Button>
              <Button
                type="button"
                disabled={!canRunMatch}
                onClick={runMatch}
              >
                Ejecutar coincidencias
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step >= 4 && table1 && matchStates && copyCols.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Paso 4 — Vista previa y descarga</CardTitle>
            <CardDescription>
              Si hay varias coincidencias en una fila, elija la opción en el
              menú. Luego descargue el Excel con las columnas agregadas.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="-mx-1 overflow-x-auto rounded-md border sm:mx-0">
              <table className="w-full min-w-[960px] table-auto text-left text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {table1.headers.map((h) => (
                      <th
                        key={h}
                        className="border-b px-3 py-2.5 text-xs font-medium sm:text-sm"
                      >
                        {h}
                      </th>
                    ))}
                    {copyCols.map((c) => {
                      const label = finalBySheet2[c] ?? c
                      const firstAdded = copyCols[0] === c
                      return (
                        <th
                          key={c}
                          className={cn(
                            'border-b px-3 py-2.5 text-xs font-medium text-emerald-800 sm:text-sm',
                            firstAdded && 'min-w-[22rem]',
                            isRucOrDniHeader(label) && 'min-w-[22rem]',
                          )}
                        >
                          {label}
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {table1.rows.map((row, ri) => {
                    const st = matchStates[ri]
                    return (
                      <tr key={ri} className="border-b border-slate-100">
                        {table1.headers.map((h) => (
                          <td
                            key={h}
                            className="max-w-[220px] truncate px-3 py-2.5 align-top text-xs sm:text-sm"
                          >
                            {row[h] === null || row[h] === undefined
                              ? ''
                              : String(row[h])}
                          </td>
                        ))}
                        {copyCols.map((c, ci) => {
                          const label = finalBySheet2[c] ?? c
                          const firstAdded = copyCols[0] === c
                          return (
                            <td
                              key={c}
                              className={cn(
                                'px-3 py-2.5 align-top text-xs sm:text-sm',
                                firstAdded && 'min-w-[22rem]',
                                isRucOrDniHeader(label) && 'min-w-[22rem]',
                              )}
                            >
                              {st?.kind === 'ambiguous' && ci === 0 ? (
                                <Select
                                  value={String(st.selectedIndex)}
                                  onValueChange={(v) =>
                                    setAmbiguousSelection(ri, Number(v))
                                  }
                                >
                                  <SelectTrigger
                                    className={cn(
                                      selectTriggerWideClass,
                                      'max-w-none',
                                    )}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent className="max-w-[min(100vw-2rem,40rem)]">
                                    {st.candidates.map((cand, idx) => (
                                      <SelectItem
                                        key={idx}
                                        value={String(idx)}
                                        className="whitespace-normal py-2"
                                      >
                                        {candidateLabel(cand, copyCols)}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : st?.kind === 'ambiguous' ? (
                                <span className="inline-block break-words">
                                  {resolveRowValue(st, c)}
                                </span>
                              ) : (
                                <span className="inline-block break-words">
                                  {st ? resolveRowValue(st, c) : 'Sin Datos'}
                                </span>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(3)}>
                Volver al mapeo
              </Button>
              <Button type="button" onClick={downloadXlsx}>
                Descargar Excel
              </Button>
              <Button type="button" variant="secondary" onClick={resetAll}>
                Empezar de nuevo
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
