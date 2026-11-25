import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export function Button({ variant = 'primary', className = '', busy, children, ...props }) {
  const styles = {
    primary: 'bg-ink text-white hover:bg-ink-soft',
    secondary: 'bg-sheet text-ink border border-line hover:border-ink-soft',
    danger: 'bg-sheet text-clash border border-line hover:border-clash',
    quiet: 'text-ink-soft hover:text-ink hover:bg-line/40',
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed ${styles[variant]} ${className}`}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

export function Field({ label, hint, error, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-sm font-bold">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-clash">{error}</span>}
    </label>
  );
}

export const inputClass = 'w-full rounded-md border border-line bg-sheet px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-ink-soft';

export const Input = (props) => <input className={inputClass} {...props} />;
export const Select = ({ children, ...props }) => (
  <select className={inputClass} {...props}>
    {children}
  </select>
);

export function PageHeader({ title, children, description }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-bold">{title}</h1>
        {description && <p className="mt-1 text-muted">{description}</p>}
      </div>
      {children && <div className="no-print flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Notice({ tone = 'info', children, className = '' }) {
  const tones = {
    info: 'border-line bg-sheet',
    error: 'border-clash/40 bg-clash-soft text-clash',
    ok: 'border-ok/30 bg-ok-soft text-ok',
    warn: 'border-marigold/50 bg-marigold-soft',
  };
  return <div className={`rounded-md border px-4 py-3 text-sm ${tones[tone]} ${className}`}>{children}</div>;
}

export function Empty({ title, children }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="font-display text-lg font-bold">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

/** Side panel for forms. Closes on Escape and returns focus to the page. */
export function Drawer({ open, title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector('input,select,textarea,button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/25" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} role="dialog" aria-modal="true" aria-label={title} className="h-full w-full max-w-md overflow-y-auto bg-sheet p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-bold">{title}</h2>
          <Button variant="quiet" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function ProgressBar({ value, label }) {
  return (
    <div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-marigold transition-[width] duration-300" style={{ width: `${value}%` }} />
      </div>
      {label && <p className="mt-1.5 text-sm text-muted">{label}</p>}
    </div>
  );
}

const ToastContext = createContext(() => {});
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, tone = 'ok', action) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, tone, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 9000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="no-print fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <Notice key={t.id} tone={t.tone} className="shadow-lg">
            <div className="flex items-start gap-3">
              <div className="flex-1">{t.message}</div>
              {t.action && (
                <button className="font-bold underline" onClick={() => (t.action.run(), setToasts((x) => x.filter((y) => y.id !== t.id)))}>
                  {t.action.label}
                </button>
              )}
            </div>
          </Notice>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);

export function Pager({ page, pages, onPage }) {
  if (!pages || pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-sm">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="text-muted">
        Page {page} of {pages}
      </span>
      <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </div>
  );
}

/** In-page "are you sure?" panel (used instead of window.confirm, which blocks the whole tab). */
export function ConfirmDrawer({ open, title, children, confirmLabel, busy, onConfirm, onClose }) {
  return (
    <Drawer open={open} title={title} onClose={onClose}>
      <div className="space-y-3 text-sm">{children}</div>
      <div className="mt-6 flex gap-2">
        <Button busy={busy} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Drawer>
  );
}
