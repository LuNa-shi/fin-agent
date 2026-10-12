import React from 'react';

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="px-7 py-5 border-b border-line bg-white flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-lg font-bold text-ink">{title}</h1>
        {subtitle && <p className="text-sm text-sub mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Btn({ children, onClick, variant = 'primary', disabled, size = 'md' }) {
  const base = 'inline-flex items-center gap-1.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed';
  const sizes = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-3.5 py-2 text-sm' };
  const variants = {
    primary: 'bg-brand text-white hover:bg-blue-600',
    ghost: 'bg-white border border-line text-ink hover:bg-slate-50',
    soft: 'bg-blue-50 text-brand hover:bg-blue-100',
    danger: 'bg-white border border-red-200 text-red-500 hover:bg-red-50',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]}`}>
      {children}
    </button>
  );
}
