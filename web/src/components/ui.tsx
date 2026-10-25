import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------- Button ---------- */

type Variant = 'primary' | 'ghost' | 'outline' | 'danger' | 'plus' | 'subtle';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-[#04121a] hover:brightness-110 shadow-[0_0_24px_-6px_rgba(52,227,255,0.6)]',
  ghost: 'bg-transparent text-text hover:bg-white/5',
  outline: 'border border-line-2 text-text hover:bg-white/5 hover:border-accent/40',
  subtle: 'bg-panel-3 text-text hover:bg-line-2',
  danger: 'bg-alert/15 text-alert border border-alert/30 hover:bg-alert/25',
  plus: 'bg-gradient-plus text-[#1b1000] font-bold hover:brightness-110 shadow-[0_0_28px_-6px_rgba(255,200,69,0.6)]',
};
const sizes = { sm: 'h-8 px-3 text-xs rounded-lg', md: 'h-10 px-4 text-sm rounded-xl', lg: 'h-12 px-5 text-base rounded-2xl' };

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof sizes; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 font-semibold transition active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none select-none whitespace-nowrap',
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('animate-spin', className || 'size-5')} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- Layout ---------- */

export function Card({
  title,
  action,
  className,
  children,
  padded = true,
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
  padded?: boolean;
}) {
  return (
    <section className={cx('rounded-2xl border border-line bg-panel/80 backdrop-blur', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h3 className="text-sm font-bold tracking-wide text-text">{title}</h3>
          {action}
        </header>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}

export function Badge({ color = '#34e3ff', children, className }: { color?: string; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4', className)}
      style={{ color, background: `${color}1f`, boxShadow: `inset 0 0 0 1px ${color}40` }}
    >
      {children}
    </span>
  );
}

export function PlusBadge({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center rounded-md bg-gradient-plus px-1.5 py-0.5 text-[10px] font-extrabold leading-3 text-[#1b1000]', className)}>
      РАДАР+
    </span>
  );
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 text-dim">{icon}</div>}
      <div className="font-semibold">{title}</div>
      {text && <div className="max-w-sm text-sm text-muted">{text}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* ---------- Forms ---------- */

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block space-y-1.5', className)}>
      <span className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-dim">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-xl border border-line-2 bg-panel-2 px-3 py-2.5 text-sm text-text placeholder:text-dim outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/15';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputCls, 'min-h-24 resize-y', props.className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(inputCls, 'appearance-none pr-8', className)}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 py-2 text-left disabled:opacity-50"
    >
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-semibold">{label}</span>}
          {description && <span className="block text-xs text-muted">{description}</span>}
        </span>
      )}
      <span
        className={cx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition',
          checked ? 'bg-accent shadow-[0_0_16px_-4px_rgba(52,227,255,0.8)]' : 'bg-line-2',
        )}
      >
        <span className={cx('absolute size-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-1 text-sm">
      <span
        className={cx(
          'grid size-5 place-items-center rounded-md border transition',
          checked ? 'border-accent bg-accent text-[#04121a]' : 'border-line-2 bg-panel-2',
        )}
      >
        {checked && (
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cx('flex gap-1 overflow-x-auto rounded-xl border border-line bg-panel-2 p-1', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cx(
            'shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold transition',
            value === t.id ? 'bg-panel-3 text-text shadow-[inset_0_0_0_1px_rgba(52,227,255,0.25)]' : 'text-muted hover:text-text',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Modal / bottom sheet ---------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal>
      <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        className={cx(
          'relative max-h-[92dvh] w-full animate-slide-up overflow-y-auto rounded-t-3xl border border-line bg-panel shadow-2xl sm:rounded-3xl safe-bottom',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-panel/95 px-5 py-4 backdrop-blur">
          <div className="text-base font-bold">{title}</div>
          <button onClick={onClose} className="grid size-8 place-items-center rounded-full text-muted hover:bg-white/5 hover:text-text" aria-label="Закрыть">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Toasts ---------- */

type ToastKind = 'info' | 'ok' | 'error' | 'alert';
interface ToastItem {
  id: number;
  text: ReactNode;
  kind: ToastKind;
}
let toastId = 0;
const listeners = new Set<(t: ToastItem) => void>();

export function toast(text: ReactNode, kind: ToastKind = 'info') {
  const item = { id: ++toastId, text, kind };
  listeners.forEach((l) => l(item));
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const l = (t: ToastItem) => {
      setItems((x) => [...x.slice(-3), t]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), t.kind === 'alert' ? 8000 : 4000);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const color: Record<ToastKind, string> = { info: '#34e3ff', ok: '#22c55e', error: '#ff3b4f', alert: '#ff3b4f' };
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3 safe-top">
      {items.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex max-w-md animate-slide-up items-start gap-3 rounded-2xl border bg-panel/95 px-4 py-3 text-sm shadow-2xl backdrop-blur"
          style={{ borderColor: `${color[t.kind]}55`, boxShadow: `0 10px 40px -10px ${color[t.kind]}55` }}
          onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))}
        >
          <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: color[t.kind] }} />
          <div>{t.text}</div>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/* ---------- Misc ---------- */

export function Stat({ label, value, color, sub }: { label: ReactNode; value: ReactNode; color?: string; sub?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-panel-2/70 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 font-mono text-2xl font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-dim">{sub}</div>}
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e) => alive && setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1), setData: (d: T) => setState((s) => ({ ...s, data: d })) };
}
