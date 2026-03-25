'use client'

import ExcelMatchWorkflow from '@/components/excel-match-workflow'

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-slate-900">
            Coincidencia entre dos hojas Excel
          </h1>
          <p className="mt-2 text-lg text-slate-600">
            Suba el Excel base y el Excel de consulta, defina las columnas de
            coincidencia y las columnas a copiar; luego descargue el resultado.
          </p>
        </div>
        <ExcelMatchWorkflow />
      </div>
    </main>
  )
}
