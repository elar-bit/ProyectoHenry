'use client';

import { useState } from 'react';
import FileUploadSection from '@/components/file-upload';
import ProcessingStatus from '@/components/processing-status';
import ResultsPreview from '@/components/results-preview';

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [parsedData, setParsedData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = (selectedFile: File) => {
    setFile(selectedFile);
    setError(null);
  };

  const handleProcess = async () => {
    if (!file) return;

    setIsProcessing(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/parse-pdf', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'No se pudo analizar el PDF');
      }

      const data = await response.json();
      setParsedData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocurrio un error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setParsedData(null);
    setError(null);
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-slate-900">
            Convertidor de Estado de cuenta PDF a Excel
          </h1>
          <p className="mt-2 text-lg text-slate-600">
            Convierte tus estados de cuenta en archivos de Excel limpios y organizados en segundos
          </p>
        </div>

        {/* Main Content */}
        <div className="space-y-6">
          {!parsedData ? (
            <>
              <FileUploadSection
                onFileSelect={handleFileSelect}
                file={file}
                isProcessing={isProcessing}
                onProcess={handleProcess}
                error={error}
              />
              {isProcessing && <ProcessingStatus />}
            </>
          ) : (
            <>
              <ResultsPreview data={parsedData} onReset={handleReset} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
