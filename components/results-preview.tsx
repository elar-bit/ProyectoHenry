'use client';

import React, { useState } from 'react';
import { Download, ChevronDown, ChevronUp } from 'lucide-react';

interface Transaction {
  fechaProc: string;
  fechaValor: string;
  description: string;
  debit: number;
  credit: number;
}

interface ResultsData {
  transactions: Transaction[];
  accountInfo: {
    accountNumber?: string;
    reportBalance?: number;
    calculatedBalance?: number;
  };
}

interface ResultsPreviewProps {
  data: ResultsData;
  onReset: () => void;
}

/** Filas mostradas en la tabla de vista previa (el Excel lleva todas). */
const PREVIEW_ROW_LIMIT = 50;

export default function ResultsPreview({
  data,
  onReset,
}: ResultsPreviewProps) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [showDetails, setShowDetails] = useState(false);

  const formatMoney = (value: number) =>
    value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const toggleRow = (index: number) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedRows(newExpanded);
  };

  const downloadExcel = async () => {
    try {
      const response = await fetch('/api/generate-excel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error('No se pudo generar el archivo de Excel');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `estado-de-cuenta-${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      alert('No se pudo descargar el archivo de Excel');
      console.error(err);
    }
  };

  // No mostramos validaciones/cálculos de saldo; solo presentamos los datos extraídos.
  const validationStatus = true;

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <div className="rounded-lg bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">
              Conversión completada
            </h2>
            <p className="mt-1 text-slate-600">
              Tu estado de cuenta se analizó correctamente y está listo para descargar
            </p>
          </div>
          <div
            className={`flex h-16 w-16 items-center justify-center rounded-full ${
              validationStatus
                ? 'bg-green-100 text-green-600'
                : 'bg-yellow-100 text-yellow-600'
            }`}
          >
            <svg
              className="h-8 w-8"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          </div>
        </div>

        {/* Validation Info */}
        {!validationStatus && (
          <div className="mt-4 rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800 ring-1 ring-yellow-200">
            <span className="font-semibold">⚠️ Desajuste de saldo:</span> El saldo
            calculado ({data.accountInfo.calculatedBalance}) es diferente del saldo
            reportado ({data.accountInfo.reportBalance}). Por favor revisa los datos.
          </div>
        )}
      </div>

        {/* Statistics Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm text-slate-600">Transacciones totales</p>
          <p className="mt-1 text-3xl font-bold text-slate-900">
            {data.transactions.length}
          </p>
        </div>
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm text-slate-600">Número de cuenta</p>
          <p className="mt-1 text-xl font-semibold text-slate-900">
            {data.accountInfo.accountNumber || 'N/A'}
          </p>
        </div>
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm text-slate-600">Saldo final</p>
          <p className="mt-1 text-xl font-semibold text-slate-900">
            {typeof data.accountInfo.calculatedBalance === 'number'
              ? formatMoney(data.accountInfo.calculatedBalance)
              : 'N/A'}
          </p>
        </div>
      </div>

      {/* Transactions Table */}
      <div className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                  Fecha Proc.
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                  Fecha Valor
                </th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-slate-900">
                  Descripcion
                </th>
                <th className="px-6 py-3 text-right text-sm font-semibold text-slate-900">
                  Cargos / Debe
                </th>
                <th className="px-6 py-3 text-right text-sm font-semibold text-slate-900">
                  Abonos / Haber
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {data.transactions
                .slice(0, PREVIEW_ROW_LIMIT)
                .map((tx, index) => (
                <tr
                  key={index}
                  className="hover:bg-slate-50 transition-colors cursor-pointer"
                  onClick={() => toggleRow(index)}
                >
                  <td className="px-6 py-4 text-sm text-slate-900">
                    {tx.fechaProc}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-900">
                    {tx.fechaValor}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-700">
                    <div className="flex items-center gap-2">
                      {expandedRows.has(index) ? (
                        <ChevronUp className="h-4 w-4 text-slate-400" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-slate-400" />
                      )}
                      <span className="truncate">{tx.description}</span>
                    </div>
                    {expandedRows.has(index) && (
                      <p className="mt-2 whitespace-normal text-xs text-slate-500">
                        {tx.description}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right text-sm font-medium text-slate-900">
                    {tx.debit !== 0 ? (
                      <span className="text-red-600">
                        {formatMoney(tx.debit)}
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                  <td className="px-6 py-4 text-right text-sm font-medium text-slate-900">
                    {tx.credit !== 0 ? (
                      <span className="text-green-600">
                        {formatMoney(tx.credit)}
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data.transactions.length > PREVIEW_ROW_LIMIT && (
          <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 text-center text-sm text-slate-600">
            Mostrando {PREVIEW_ROW_LIMIT} de {data.transactions.length}{' '}
            transacciones (todas se incluirán en el archivo de Excel)
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={downloadExcel}
          className="flex-1 rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-blue-700 flex items-center justify-center gap-2"
        >
          <Download className="h-5 w-5" />
          Descargar archivo de Excel
        </button>
        <button
          type="button"
          onClick={onReset}
          className="rounded-lg bg-slate-200 px-6 py-3 font-semibold text-slate-900 transition-colors hover:bg-slate-300"
        >
          Convertir otro archivo
        </button>
      </div>
    </div>
  );
}
