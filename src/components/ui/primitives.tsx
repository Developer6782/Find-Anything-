import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, type HTMLAttributes } from 'react';
import { X } from 'lucide-react';

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'icon';
  size?: 'sm' | 'md' | 'lg';
};

export function Button({ variant = 'ghost', size = 'md', className, children, ...rest }: ButtonProps) {
  const base =
    variant === 'primary' ? 'btn-primary' : variant === 'icon' ? 'btn-icon' : 'btn-ghost';
  const sizing = variant === 'icon' ? '' : size === 'lg' ? 'px-6 py-3 text-base' : size === 'sm' ? 'px-3 py-1.5 text-xs' : '';
  return (
    <button className={cx(base, sizing, className)} {...rest}>
      {children}
    </button>
  );
}

export function Panel({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cx('glass p-4', className)} {...rest}>
      {children}
    </div>
  );
}

export function Pill({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'good' | 'warn' | 'error' | 'cyan' | 'violet';
  children: ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'border-white/[0.12] bg-white/[0.05] text-slate-300',
    good: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    warn: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
    error: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
    cyan: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100',
    violet: 'border-violet-400/30 bg-violet-400/10 text-violet-200',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />;
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="label block" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-slate-400">{hint}</p> : null}
    </div>
  );
}

export const inputClass =
  'focus-ring w-full rounded-xl border border-white/[0.12] bg-void-800/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not([data-close])',
    );
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-void-900/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'glass relative z-10 max-h-[92vh] w-full overflow-y-auto p-5 sm:rounded-2xl',
          size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            {description ? <p className="mt-1 text-sm text-slate-400">{description}</p> : null}
          </div>
          <Button variant="icon" onClick={onClose} aria-label="Close dialog" data-close className="h-9 w-9">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-4">{children}</div>
        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

export function StatRow({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'good' | 'warn';
}) {
  const toneClass = tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-slate-100';
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-slate-400">{label}</span>
      <span className={cx('font-mono text-xs', toneClass)}>{value}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: ReactNode;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/[0.12] px-4 py-6 text-center">
      <div className="text-cyan-300/80">{icon}</div>
      <p className="text-sm font-medium text-slate-200">{title}</p>
      <p className="max-w-xs text-xs leading-relaxed text-slate-400">{message}</p>
      {action}
    </div>
  );
}
