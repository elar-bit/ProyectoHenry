'use client';

const ProcessingStatus = () => {
  const steps = [
    { label: 'Extracting text from PDF', icon: '📄' },
    { label: 'Parsing transactions', icon: '🔍' },
    { label: 'Cleaning data', icon: '✨' },
    { label: 'Generating Excel file', icon: '📊' },
  ];

  return (
    <div className="space-y-4 rounded-lg bg-white p-8 shadow-sm ring-1 ring-slate-200">
      <h3 className="font-semibold text-slate-900">Processing your file...</h3>
      <div className="space-y-3">
        {steps.map((step, index) => (
          <div key={index} className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm">
              <span className="animate-pulse">{step.icon}</span>
            </div>
            <span className="text-slate-700">{step.label}</span>
            <div className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full w-full animate-pulse bg-blue-500"
                style={{
                  animation: 'pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ProcessingStatus;
