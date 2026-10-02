const fmtCache = new Map<string, Intl.NumberFormat>();

export function money(cents: number, currency = "USD", opts: { sign?: boolean } = {}): string {
  const key = currency + (opts.sign ? "s" : "");
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat("en-US", { style: "currency", currency, signDisplay: opts.sign ? "exceptZero" : "auto" });
    } catch {
      f = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    }
    fmtCache.set(key, f);
  }
  return f.format(cents / 100);
}

/** "12.50" style string for inputs. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function todayISO(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function parseDay(iso: string): Date {
  return new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
}

export function shortDate(iso: string): { mon: string; day: number } {
  const d = parseDay(iso);
  return { mon: d.toLocaleString("en-US", { month: "short" }), day: d.getDate() };
}

export function longDate(iso: string): string {
  return parseDay(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function monthLabel(iso: string): string {
  return parseDay(iso).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export const CURRENCIES = ["USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "SGD", "AED", "CHF", "MXN", "BRL"];

/** Short money for chart labels: $45, $480, $1.2k, $12k. */
export function moneyShort(cents: number, currency = "USD"): string {
  const v = Math.abs(cents) / 100;
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency, notation: v >= 1000 ? "compact" : "standard", maximumFractionDigits: v >= 1000 ? 1 : 0, minimumFractionDigits: 0 });
  return (cents < 0 ? "-" : "") + fmt.format(v);
}
