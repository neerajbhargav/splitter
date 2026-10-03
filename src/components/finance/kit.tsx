"use client";
import { useCallback, useState, type ReactNode } from "react";
import {
  ArrowLeftRight, Banknote, Building2, Car, CircleAlert, CircleCheck, CircleHelp, Clapperboard, CreditCard, HeartPulse, House, Landmark,
  PiggyBank, Plane, Repeat, Shapes, ShoppingBag, ShoppingCart, Tag, TrendingUp, TriangleAlert, UtensilsCrossed, Wallet, Zap, type LucideIcon,
} from "lucide-react";
import { BigMoney } from "@/components/kit";
import { money } from "@/lib/format";
import type { AccountType, CategoryKind, FinanceCategory, FinanceContext, FinanceTransaction } from "@/lib/finance-types";
import { useFinance, sameContext } from "./FinanceProvider";

/* ---------- formatting ---------- */
export function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency");
    return part?.value ?? currency;
  } catch {
    return currency;
  }
}

/** "$1,240" for whole amounts, "$1,240.50" otherwise. For chips and axis-free summaries only. */
export function moneyTight(cents: number, currency: string): string {
  const full = money(cents, currency);
  return cents % 100 === 0 ? full.replace(/[.,]00(?=\D*$)/, "") : full;
}

function parseDay(iso: string) {
  return new Date(`${iso.slice(0, 10)}T00:00:00`);
}
export function dayDiff(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
}
export function relativeDay(date: string, today: string): string {
  const d = dayDiff(today, date);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  if (d > 1 && d <= 31) return `In ${d} days`;
  if (d < -1 && d > -7) return `${-d} days ago`;
  return shortDay(date);
}
export function shortDay(date: string): string {
  return parseDay(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
export function weekdayDay(date: string, today: string): string {
  const d = dayDiff(today, date);
  if (d === 0) return "Today";
  if (d === -1) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (date.slice(0, 4) !== today.slice(0, 4)) opts.year = "numeric";
  return parseDay(date).toLocaleDateString("en-US", opts);
}
/** "Oct '26" */
export function monthShort(month: string): string {
  const d = parseDay(month.length === 7 ? `${month}-01` : month);
  return `${d.toLocaleDateString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
}
export function monthLong(month: string): string {
  return parseDay(month.length === 7 ? `${month}-01` : month).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
export function pct(n: number): string {
  return `${Math.round(n)}%`;
}

/* ---------- inputs ---------- */
export function MoneyInput({ id, value, onChange, currency, placeholder = "0.00", autoFocus, label, disabled, large }: {
  id: string; value: string; onChange: (v: string) => void; currency: string; placeholder?: string; autoFocus?: boolean; label?: string; disabled?: boolean; large?: boolean;
}) {
  const symbol = currencySymbol(currency);
  return (
    <div className={`fin-money ${large ? "lg" : ""}`}>
      <span aria-hidden className={symbol.length > 1 ? "wide" : ""}>{symbol}</span>
      <input id={id} className="input num" inputMode="decimal" autoComplete="off" value={value} placeholder={placeholder} aria-label={label}
        autoFocus={autoFocus} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        style={{ paddingLeft: symbol.length > 1 ? 14 + symbol.length * 9 : undefined }} />
    </div>
  );
}

/** Chips that set an amount, e.g. extra payment presets. */
export function AmountChips({ values, currency, current, onPick }: { values: number[]; currency: string; current: number | null; onPick: (cents: number) => void }) {
  return (
    <div className="fin-chips">
      {values.map((v) => (
        <button key={v} type="button" className={`chip plain ${current === v ? "on" : ""}`} onClick={() => onPick(v)}>
          {v === 0 ? "None" : `+${moneyTight(v, currency)}`}
        </button>
      ))}
    </div>
  );
}

/* ---------- icons ---------- */
const CATEGORY_ICONS: [RegExp, LucideIcon][] = [
  [/hous|rent|mortgage|home/i, House],
  [/grocer|food|market/i, ShoppingCart],
  [/utilit|electric|internet|phone|bill/i, Zap],
  [/transport|car|gas|fuel|transit|commut/i, Car],
  [/health|medical|gym|fitness|pharm/i, HeartPulse],
  [/debt|loan|credit/i, Landmark],
  [/dining|restaurant|eat|coffee|drink/i, UtensilsCrossed],
  [/shop|clothes|apparel/i, ShoppingBag],
  [/subscri|stream|software/i, Repeat],
  [/entertain|fun|movie|game/i, Clapperboard],
  [/travel|trip|vacation|flight/i, Plane],
  [/saving|emergency|vault/i, PiggyBank],
  [/invest|retire|brokerage|401k|ira/i, TrendingUp],
  [/other|misc/i, Shapes],
];
export function categoryIcon(name: string | undefined, kind?: CategoryKind): LucideIcon {
  if (name) for (const [re, icon] of CATEGORY_ICONS) if (re.test(name)) return icon;
  return kind === "savings" ? PiggyBank : Tag;
}
const ACCOUNT_ICONS: Record<AccountType, LucideIcon> = {
  checking: Wallet, savings: PiggyBank, cash: Banknote, investment: TrendingUp, credit: CreditCard, loan: Landmark,
};
export function AccountIcon({ type, gold }: { type: AccountType; gold?: boolean }) {
  const Icon = ACCOUNT_ICONS[type] ?? Building2;
  return <span className={`icon-tile ${gold ? "gold" : ""}`}><Icon /></span>;
}
export function CategoryTile({ category, transfer, income, size }: { category?: FinanceCategory | null; transfer?: boolean; income?: boolean; size?: "sm" }) {
  const Icon = transfer ? ArrowLeftRight : income ? Banknote : categoryIcon(category?.name, category?.kind);
  return <span className={`icon-tile ${income ? "fin-in" : ""} ${size === "sm" ? "sm" : ""}`}><Icon /></span>;
}

/* ---------- hero ---------- */
export function Hero({ label, cents, currency, tone, children, actions, note }: {
  label: ReactNode; cents: number; currency: string; tone?: "pos" | "neg" | "auto"; children?: ReactNode; actions?: ReactNode; note?: ReactNode;
}) {
  const cls = tone === "pos" ? "pos" : tone === "neg" ? "neg" : tone === "auto" ? (cents < 0 ? "neg" : "") : "";
  return (
    <section className="card fin-hero">
      <div className="hero-bal">
        <div className="hb-label">{label}</div>
        <div className={`big ${cls}`}><BigMoney cents={cents} currency={currency} sign={cents < 0} /></div>
        {children && <div className="sub">{children}</div>}
        {actions && <div className="hero-actions">{actions}</div>}
        {note && <div className="fin-hero-note">{note}</div>}
      </div>
    </section>
  );
}
export function HeroText({ label, value, children, actions, note }: { label: ReactNode; value: ReactNode; children?: ReactNode; actions?: ReactNode; note?: ReactNode }) {
  return (
    <section className="card fin-hero">
      <div className="hero-bal">
        <div className="hb-label">{label}</div>
        <div className="big fin-big-text">{value}</div>
        {children && <div className="sub">{children}</div>}
        {actions && <div className="hero-actions">{actions}</div>}
        {note && <div className="fin-hero-note">{note}</div>}
      </div>
    </section>
  );
}
export function Pill({ color, label, value }: { color?: string; label: ReactNode; value?: ReactNode }) {
  return (
    <span className="pill-stat">
      {color && <i className="dot" style={{ background: color }} />}
      {label}
      {value !== undefined && <b className="num">{value}</b>}
    </span>
  );
}

/* ---------- status ---------- */
export type Tone = "pass" | "warn" | "fail" | "unknown";
const STATUS: Record<Tone, { label: string; icon: LucideIcon; cls: string }> = {
  pass: { label: "On track", icon: CircleCheck, cls: "pos" },
  warn: { label: "Close", icon: TriangleAlert, cls: "gold" },
  fail: { label: "Off track", icon: CircleAlert, cls: "neg" },
  unknown: { label: "Needs info", icon: CircleHelp, cls: "faint" },
};
export function StatusChip({ status }: { status: Tone }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return <span className={`fin-status ${status}`}><Icon />{s.label}</span>;
}

export function DateTile({ date }: { date: string }) {
  const d = parseDay(date);
  return (
    <span className="datebox fin-datebox">
      <div className="m">{d.toLocaleDateString("en-US", { month: "short" })}</div>
      <div className="d">{d.getDate()}</div>
    </span>
  );
}

/** Ledger amount: income "+$12.00" green, transfer neutral, expense plain. */
export function TxAmount({ tx, currency }: { tx: Pick<FinanceTransaction, "amount_cents" | "kind">; currency: string }) {
  if (tx.kind === "income") return <span className="num pos">+{money(tx.amount_cents, currency)}</span>;
  if (tx.kind === "transfer") return <span className="num faint">{money(tx.amount_cents, currency)}</span>;
  return <span className="num">{money(tx.amount_cents, currency)}</span>;
}

/* ---------- drafts ---------- */
/**
 * A draft (modal form) remembers the account + currency that were live when it opened.
 * Saving compares against the live values so a draft can never land in another account or be relabeled in another currency.
 */
export function useDraftContext() {
  const { ctx } = useFinance();
  const [captured, setCaptured] = useState<FinanceContext | null>(null);
  const capture = useCallback(() => setCaptured({ ...ctx }), [ctx]);
  const release = useCallback(() => setCaptured(null), []);
  const stale = captured !== null && !sameContext(captured, ctx);
  return { captured, capture, release, stale };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
