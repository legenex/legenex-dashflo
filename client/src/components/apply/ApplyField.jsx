import React from 'react';

// A labelled text/number input for the public onboarding form. Shows an inline
// error message under the field when the server returns a validation problem.
export function ApplyField({ label, value, onChange, error, type = 'text', placeholder = '', required = false }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
        {label}{required && <span className="text-primary ml-0.5">*</span>}
      </label>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`h-11 w-full rounded-lg border bg-background px-3.5 text-[14px] text-foreground placeholder:text-muted-foreground/50 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          error ? 'border-primary' : 'border-border'
        }`}
      />
      {error && <div className="mt-1 text-[12px] text-primary">{error}</div>}
    </div>
  );
}

// A labelled textarea variant for longer free text answers.
export function ApplyTextarea({ label, value, onChange, error, placeholder = '', rows = 3 }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
        {label}
      </label>
      <textarea
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={`w-full rounded-lg border bg-background px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground/50 transition-colors resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          error ? 'border-primary' : 'border-border'
        }`}
      />
      {error && <div className="mt-1 text-[12px] text-primary">{error}</div>}
    </div>
  );
}