'use client';

import React, { useRef } from 'react';
import { Upload } from 'lucide-react';

interface FileUploadSectionProps {
  onFileSelect: (file: File) => void;
  file: File | null;
  isProcessing: boolean;
  onProcess: () => void;
  error: string | null;
}

export default function FileUploadSection({
  onFileSelect,
  file,
  isProcessing,
  onProcess,
  error,
}: FileUploadSectionProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const pdfFile = files[0];
      if (pdfFile.type === 'application/pdf') {
        onFileSelect(pdfFile);
      } else {
        alert('Selecciona un archivo PDF');
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.currentTarget.files;
    if (files && files.length > 0) {
      onFileSelect(files[0]);
    }
  };

  return (
    <div className="space-y-6 rounded-lg bg-white p-8 shadow-sm ring-1 ring-slate-200">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-slate-900">Paso 1: Subir archivo</h2>
        <p className="text-slate-600">
          Selecciona un archivo PDF con tu estado de cuenta (Estado de cuenta PDF)
        </p>
      </div>

      <div
        className="space-y-3 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-8 text-center transition-colors hover:border-slate-400 hover:bg-slate-100"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="flex justify-center">
          <div className="rounded-full bg-blue-100 p-4">
            <Upload className="h-8 w-8 text-blue-600" />
          </div>
        </div>
        <div className="space-y-1">
          <p className="font-semibold text-slate-900">
            Arrastra y suelta tu PDF aqui
          </p>
          <p className="text-sm text-slate-500">o</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-sm font-semibold text-blue-600 hover:text-blue-700"
          >
            haz clic para buscar
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {file && (
        <div className="flex items-center justify-between rounded-lg bg-green-50 p-4 ring-1 ring-green-200">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-green-100 p-2">
              <svg
                className="h-5 w-5 text-green-600"
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
            <div>
              <p className="font-medium text-slate-900">{file.name}</p>
              <p className="text-sm text-slate-600">
                {(file.size / 1024).toFixed(2)} KB
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onFileSelect(null as any);
              if (inputRef.current) inputRef.current.value = '';
            }}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Eliminar
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 rounded-lg bg-red-50 p-4 ring-1 ring-red-200">
          <div className="rounded-full bg-red-100 p-2">
            <svg
              className="h-5 w-5 text-red-600"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="text-sm text-red-700">{error}</div>
        </div>
      )}

      <button
        type="button"
        onClick={onProcess}
        disabled={!file || isProcessing}
        className="w-full rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-500"
      >
        {isProcessing ? 'Procesando...' : 'Procesar y convertir'}
      </button>
    </div>
  );
}
