// Small shadcn/ui-style primitives (Card, Badge, Progress) on top of the app's CSS tokens.
import type { ReactNode } from "react";
import { money } from "@/lib/format";

export function Card({ title, description, action, children, className = "", style }: {
  title?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; style?: React.CSSProperties;
}) {
  return (
    <section className={`card ${className}`} style={style}>
      {(title || action) && (
        <div className="card-head">
          <div style={{ minWidth: 0 }}>
            {title && <div className="card-title">{title}</div>}
            {description && <div className="card-desc">{description}</div>}
          </div>
          {action}
        </div>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Progress({ value, max, size, tone = "pos" }: { value: number; max: number; size?: "sm"; tone?: "pos" | "neg" }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={`progress ${size ?? ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${pct}%`, background: tone === "neg" ? "var(--neg)" : undefined }} />
    </div>
  );
}

/** Cash App style big number: $1,234 with small cents. */
export function BigMoney({ cents, currency, sign }: { cents: number; currency: string; sign?: boolean }) {
  const s = money(Math.abs(cents), currency);
  const m = s.match(/^(.*?)([.,]\d{2})$/);
  const pre = sign && cents !== 0 ? (cents > 0 ? "+" : "−") : "";
  return m ? <>{pre}{m[1]}<span className="cents">{m[2]}</span></> : <>{pre}{s}</>;
}
