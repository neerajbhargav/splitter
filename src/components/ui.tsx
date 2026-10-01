"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
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

/** SPLITTER mark: a yin-yang split by an S-line that tapers into the edge. Two halves that always balance out. */
const YIN = "M50 3A47 47 0 0 0 50 97A23.5 23.5 0 0 0 50 50A23.5 23.5 0 0 1 50 3Z";
/** The divider: full width in the middle, tapering to nothing where it meets the circle. */
const SPLIT = "M50.00 3.00 L48.46 3.04 L46.93 3.16 L45.40 3.36 L43.87 3.64 L42.36 4.00 L40.86 4.44 L39.38 4.97 L37.92 5.57 L36.48 6.27 L35.08 7.06 L33.71 7.93 L32.40 8.90 L31.13 9.96 L29.94 11.11 L28.82 12.35 L27.79 13.68 L26.85 15.09 L26.02 16.57 L25.31 18.12 L24.71 19.72 L24.23 21.37 L23.88 23.06 L23.65 24.77 L23.55 26.50 L23.57 28.23 L23.71 29.96 L23.97 31.68 L24.35 33.37 L24.84 35.04 L25.44 36.67 L26.16 38.26 L26.97 39.79 L27.89 41.27 L28.90 42.69 L30.00 44.04 L31.19 45.31 L32.46 46.50 L33.81 47.60 L35.22 48.62 L36.70 49.54 L38.24 50.36 L39.82 51.07 L41.45 51.69 L43.12 52.19 L44.81 52.59 L46.53 52.87 L48.26 53.04 L50.00 53.10 L51.33 53.14 L52.66 53.27 L53.98 53.49 L55.28 53.80 L56.56 54.18 L57.81 54.65 L59.02 55.20 L60.20 55.83 L61.33 56.54 L62.42 57.31 L63.45 58.16 L64.43 59.07 L65.34 60.05 L66.19 61.08 L66.97 62.16 L67.68 63.29 L68.31 64.47 L68.87 65.69 L69.35 66.93 L69.75 68.21 L70.07 69.51 L70.30 70.83 L70.46 72.16 L70.55 73.50 L70.55 74.85 L70.48 76.20 L70.33 77.54 L70.11 78.89 L69.81 80.23 L69.45 81.56 L69.01 82.87 L68.49 84.18 L67.90 85.46 L67.23 86.72 L66.47 87.94 L65.63 89.13 L64.70 90.27 L63.69 91.34 L62.60 92.35 L61.42 93.28 L60.17 94.12 L58.85 94.86 L57.47 95.50 L56.04 96.04 L54.57 96.46 L53.06 96.76 L51.54 96.94 L50.00 97.00 L51.54 96.96 L53.07 96.84 L54.60 96.64 L56.13 96.36 L57.64 96.00 L59.14 95.56 L60.62 95.03 L62.08 94.43 L63.52 93.73 L64.92 92.94 L66.29 92.07 L67.60 91.10 L68.87 90.04 L70.06 88.89 L71.18 87.65 L72.21 86.32 L73.15 84.91 L73.98 83.43 L74.69 81.88 L75.29 80.28 L75.77 78.63 L76.12 76.94 L76.35 75.23 L76.45 73.50 L76.43 71.77 L76.29 70.04 L76.03 68.32 L75.65 66.63 L75.16 64.96 L74.56 63.33 L73.84 61.74 L73.03 60.21 L72.11 58.73 L71.10 57.31 L70.00 55.96 L68.81 54.69 L67.54 53.50 L66.19 52.40 L64.78 51.38 L63.30 50.46 L61.76 49.64 L60.18 48.93 L58.55 48.31 L56.88 47.81 L55.19 47.41 L53.47 47.13 L51.74 46.96 L50.00 46.90 L48.67 46.86 L47.34 46.73 L46.02 46.51 L44.72 46.20 L43.44 45.82 L42.19 45.35 L40.98 44.80 L39.80 44.17 L38.67 43.46 L37.58 42.69 L36.55 41.84 L35.57 40.93 L34.66 39.95 L33.81 38.92 L33.03 37.84 L32.32 36.71 L31.69 35.53 L31.13 34.31 L30.65 33.07 L30.25 31.79 L29.93 30.49 L29.70 29.17 L29.54 27.84 L29.45 26.50 L29.45 25.15 L29.52 23.80 L29.67 22.46 L29.89 21.11 L30.19 19.77 L30.55 18.44 L30.99 17.13 L31.51 15.82 L32.10 14.54 L32.77 13.28 L33.53 12.06 L34.37 10.87 L35.30 9.73 L36.31 8.66 L37.40 7.65 L38.58 6.72 L39.83 5.88 L41.15 5.14 L42.53 4.50 L43.96 3.96 L45.43 3.54 L46.94 3.24 L48.46 3.06Z";
export function LogoMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={`logo-mark ${className}`} aria-hidden>
      <defs>
        <mask id={`lm${id}`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="white" />
          <path d={SPLIT} fill="black" />
        </mask>
      </defs>
      <g mask={`url(#lm${id})`}>
        <circle className="lm-b" cx="50" cy="50" r="47" />
        <path className="lm-a" d={YIN} />
        <circle className="lm-b" cx="50" cy="73.5" r="7" />
        <circle className="lm-a" cx="50" cy="26.5" r="7" />
      </g>
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
