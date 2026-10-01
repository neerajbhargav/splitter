"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import { initials, money } from "@/lib/format";

export function Avatar({ name, color = "#c9a96e", src, size = 32 }: { name: string; color?: string; src?: string | null; size?: number }) {
  return (
    <span className="avatar" style={{ ["--size" as string]: `${size}px`, background: src ? "var(--surface-3)" : color }} title={name}>
      {src ? <img src={src} alt="" referrerPolicy="no-referrer" /> : initials(name)}
    </span>
  );
}

export function Money({ cents, currency, sign, tone }: { cents: number; currency: string; sign?: boolean; tone?: "auto" | "none" }) {
  const cls = tone === "none" ? "" : cents > 0 ? "pos" : cents < 0 ? "neg" : "faint";
  return <span className={`num ${cls}`}>{money(sign ? cents : Math.abs(cents), currency, { sign })}</span>;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 className="spin" width={size} height={size} />;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="center-screen">
      <Spinner /> <span>{label}</span>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="serif">{title}</div>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`switch ${on ? "on" : ""}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function Segmented<T extends string>({ value, options, onChange, block }: {
  value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void; block?: boolean;
}) {
  return (
    <div className={`seg ${block ? "seg-block" : ""}`} role="tablist">
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className={`modal-card ${wide ? "wide" : ""}`}>
          <div className="modal-head">
            <h2>{title}</h2>
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
              <X />
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/** SPLITTER mark: a classic taijitu built from true geometry (outer ring, an S of two
 *  half-radius arcs, a seed dot centred in each half). One gold shape; the other half is
 *  negative space, filled with ink on light backgrounds so both halves always read. */
const MARK = "M2 50A48 48 0 1 0 98 50A48 48 0 1 0 2 50ZM50 9A41 41 0 0 0 50 91A20.5 20.5 0 0 0 50 50A20.5 20.5 0 0 1 50 9ZM43.44 70.5A6.56 6.56 0 1 0 56.56 70.5A6.56 6.56 0 1 0 43.44 70.5ZM43.44 29.5A6.56 6.56 0 1 0 56.56 29.5A6.56 6.56 0 1 0 43.44 29.5Z";
export function LogoMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={`logo-mark ${className}`} aria-hidden>
      <circle className="lm-yin" cx="50" cy="50" r="41.4" />
      <path className="lm-yang" fillRule="evenodd" d={MARK} />
    </svg>
  );
}

export function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}

export function GitHubLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}
