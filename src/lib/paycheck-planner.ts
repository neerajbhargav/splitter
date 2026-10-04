import { renewalDatesInWindow, subscriptionEquivalent } from "./subscription-planner.ts";
import type { BudgetLimit, FinanceCategory, PayCycle, PaycheckAllocation, AllocationKind, Subscription } from "./finance-types.ts";

/**
 * Paycheck planning: when the next paydays land, what each one has to cover before the
 * following payday, and how much is still unassigned. Integer cents throughout.
 */

export type PaySchedule = { cycle: PayCycle; anchor: string; day2: number | null };

export const PAY_CYCLE_LABEL: Record<PayCycle, string> = {
  weekly: "Every week", biweekly: "Every 2 weeks", semimonthly: "Twice a month", monthly: "Once a month",
};
export const ALLOCATION_KIND_LABEL: Record<AllocationKind, string> = {
  bill: "Bills", debt: "Debt", spending: "Spending", savings: "Savings", other: "Other",
};
export const ALLOCATION_ORDER: readonly AllocationKind[] = ["bill", "debt", "spending", "savings", "other"];

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(iso: string): [number, number, number] {
  const m = ISO.exec(iso);
  if (!m) throw new RangeError("Dates must use YYYY-MM-DD");
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) throw new RangeError("Invalid date");
  return [y, mo, d];
}
export function isIsoDate(iso: string): boolean {
  try { parts(iso); return true; } catch { return false; }
}
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function dayNumber(iso: string): number {
  const [y, m, d] = parts(iso);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}
function fromDayNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}
export function addDays(iso: string, days: number): string {
  return fromDayNumber(dayNumber(iso) + days);
}
function isoOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Day `day` of a month, moved back to the last day when the month is shorter. 31 always means the last day. */
function clampedDay(y: number, m: number, day: number): string {
  return isoOf(y, m, Math.min(day, daysInMonth(y, m)));
}
function shiftMonth(y: number, m: number, delta: number): [number, number] {
  const i = y * 12 + (m - 1) + delta;
  return [Math.floor(i / 12), (i % 12) + 1];
}

export function periodsPerYear(cycle: PayCycle): number {
  return cycle === "weekly" ? 52 : cycle === "biweekly" ? 26 : cycle === "semimonthly" ? 24 : 12;
}

export function scheduleFromSettings(s: { pay_cycle: PayCycle | null; pay_anchor: string | null; pay_day2: number | null } | null | undefined): PaySchedule | null {
  if (!s?.pay_cycle || !s.pay_anchor || !isIsoDate(String(s.pay_anchor).slice(0, 10))) return null;
  if (s.pay_cycle === "semimonthly" && !s.pay_day2) return null;
  return { cycle: s.pay_cycle, anchor: String(s.pay_anchor).slice(0, 10), day2: s.pay_cycle === "semimonthly" ? s.pay_day2 : null };
}

/** Paydays on or after `from`, in order. */
export function paydaysFrom(schedule: PaySchedule, from: string, count: number): string[] {
  const out: string[] = [];
  if (count <= 0) return out;
  if (schedule.cycle === "weekly" || schedule.cycle === "biweekly") {
    const step = schedule.cycle === "weekly" ? 7 : 14;
    const anchor = dayNumber(schedule.anchor);
    const k = Math.ceil((dayNumber(from) - anchor) / step);
    for (let i = 0; i < count; i++) out.push(fromDayNumber(anchor + (k + i) * step));
    return out;
  }
  const [, , anchorDay] = parts(schedule.anchor);
  const days = schedule.cycle === "monthly" ? [anchorDay] : [anchorDay, schedule.day2 ?? anchorDay];
  let [y, m] = parts(from);
  for (let guard = 0; out.length < count && guard < 1200; guard++) {
    const month = [...new Set(days.map((d) => clampedDay(y, m, d)))].sort();
    for (const date of month) if (date >= from && out.length < count) out.push(date);
    [y, m] = shiftMonth(y, m, 1);
  }
  return out;
}

/** First payday strictly after `date`. */
export function nextPaydayAfter(schedule: PaySchedule, date: string): string {
  return paydaysFrom(schedule, addDays(date, 1), 1)[0];
}

/** What a paycheck covers: from its payday up to (not including) the next one. */
export type PayPeriod = { start: string; end: string; last: string; days: number };
export function payPeriod(payDate: string, schedule: PaySchedule | null): PayPeriod {
  const end = schedule ? nextPaydayAfter(schedule, payDate) : addDays(payDate, 14);
  return { start: payDate, end, last: addDays(end, -1), days: dayNumber(end) - dayNumber(payDate) };
}

/** A monthly amount's share of one paycheck, rounded half up to the cent. */
export function perPaycheckCents(monthlyCents: number, cycle: PayCycle): number {
  if (!Number.isSafeInteger(monthlyCents) || monthlyCents < 0) throw new RangeError("Amount must be whole cents");
  const ppy = BigInt(periodsPerYear(cycle));
  return Number((BigInt(monthlyCents) * 24n + ppy) / (2n * ppy));
}

/** Dates in [start, end) that fall on `day` of a month (clamped to short months). */
export function dueDatesInPeriod(day: number, period: Pick<PayPeriod, "start" | "end">): string[] {
  const out: string[] = [];
  let [y, m] = parts(period.start);
  const [ey, em] = parts(period.end);
  while (y * 12 + m <= ey * 12 + em) {
    const date = clampedDay(y, m, day);
    if (date >= period.start && date < period.end) out.push(date);
    [y, m] = shiftMonth(y, m, 1);
  }
  return out;
}

export type PlannedDebt = { id: string; name: string; due_day: number | null };
export type SuggestedLine = Omit<PaycheckAllocation, "id" | "done"> & { due_date: string | null; reason: string };

export type SuggestInput = {
  period: Pick<PayPeriod, "start" | "end" | "last">;
  cycle: PayCycle;
  subscriptions: readonly Pick<Subscription, "id" | "name" | "amount_cents" | "cycle" | "anchor_date" | "status" | "category_id">[];
  debts: readonly PlannedDebt[];
  /** Planned payment for a debt in a YYYY-MM month (0 once it is paid off). */
  debtPaymentFor: (debtId: string, month: string) => number;
  categories: readonly FinanceCategory[];
  /** Budget limits for the month the paycheck lands in. */
  limits: readonly BudgetLimit[];
};

/**
 * Lines a paycheck should cover:
 * - bills and debts with a due date in this pay period get their full amount,
 * - debts without a due date and budget categories get this paycheck's share of the month,
 * - subscriptions are taken out of their category so nothing is counted twice.
 */
export function suggestAllocations(input: SuggestInput): SuggestedLine[] {
  const { period, cycle } = input;
  const month = period.start.slice(0, 7);
  const lines: SuggestedLine[] = [];

  const subMonthlyByCategory = new Map<string, number>();
  for (const sub of input.subscriptions) {
    if (sub.status !== "active") continue;
    if (sub.category_id) {
      const monthly = Number(subscriptionEquivalent(sub.amount_cents, sub.cycle).monthly_cents);
      subMonthlyByCategory.set(sub.category_id, (subMonthlyByCategory.get(sub.category_id) ?? 0) + monthly);
    }
    const dates = renewalDatesInWindow(sub.anchor_date, sub.cycle, period.start, period.last);
    if (!dates.length) continue;
    lines.push({
      label: sub.name, kind: "bill", ref_id: sub.id, amount_cents: sub.amount_cents * dates.length, due_date: dates[0],
      reason: dates.length === 1 ? "Renews this pay period" : `Renews ${dates.length} times this pay period`,
    });
  }

  for (const debt of input.debts) {
    if (debt.due_day) {
      let total = 0;
      const dates = dueDatesInPeriod(debt.due_day, period);
      for (const date of dates) total += input.debtPaymentFor(debt.id, date.slice(0, 7));
      if (total > 0) lines.push({ label: debt.name, kind: "debt", ref_id: debt.id, amount_cents: total, due_date: dates[0], reason: "Payment due this pay period" });
    } else {
      const share = perPaycheckCents(input.debtPaymentFor(debt.id, month), cycle);
      if (share > 0) lines.push({ label: debt.name, kind: "debt", ref_id: debt.id, amount_cents: share, due_date: null, reason: "This paycheck's share of the monthly payment" });
    }
  }

  const byId = new Map(input.categories.map((c) => [c.id, c]));
  const spending: SuggestedLine[] = [];
  const saving: SuggestedLine[] = [];
  for (const limit of input.limits) {
    const cat = byId.get(limit.category_id);
    if (!cat || cat.archived || limit.limit_cents <= 0) continue;
    if (cat.kind !== "savings" && input.debts.length > 0 && /debt/i.test(cat.name)) continue;
    const flexible = limit.limit_cents - (subMonthlyByCategory.get(cat.id) ?? 0);
    if (flexible <= 0) continue;
    const share = perPaycheckCents(flexible, cycle);
    if (share <= 0) continue;
    const line: SuggestedLine = {
      label: cat.name, kind: cat.kind === "savings" ? "savings" : "spending", ref_id: cat.id, amount_cents: share, due_date: null,
      reason: subMonthlyByCategory.has(cat.id) ? "This paycheck's share, minus subscriptions listed above" : "This paycheck's share of your budget",
    };
    (cat.kind === "savings" ? saving : spending).push(line);
  }
  const kindRank = (c?: FinanceCategory) => (c?.kind === "needs" ? 0 : 1);
  spending.sort((a, b) => kindRank(byId.get(a.ref_id!)) - kindRank(byId.get(b.ref_id!)) || (byId.get(a.ref_id!)?.sort ?? 0) - (byId.get(b.ref_id!)?.sort ?? 0));

  const dated = (a: SuggestedLine, b: SuggestedLine) => (a.due_date ?? "9999") .localeCompare(b.due_date ?? "9999") || a.label.localeCompare(b.label);
  return [
    ...lines.filter((l) => l.kind === "bill").sort(dated),
    ...lines.filter((l) => l.kind === "debt").sort(dated),
    ...spending,
    ...saving,
  ];
}

/** Adds suggestions that aren't already on the paycheck (matched by type and what they point to). */
export function mergeSuggestions(existing: readonly PaycheckAllocation[], suggested: readonly SuggestedLine[], newId: () => string): PaycheckAllocation[] {
  const have = new Set(existing.map((a) => `${a.kind}:${a.ref_id ?? a.label.toLowerCase()}`));
  const added = suggested
    .filter((s) => !have.has(`${s.kind}:${s.ref_id ?? s.label.toLowerCase()}`))
    .map((s) => ({ id: newId(), label: s.label, kind: s.kind, ref_id: s.ref_id, amount_cents: s.amount_cents, done: false }));
  return [...existing, ...added];
}

export type PaycheckTotals = { assigned_cents: number; left_cents: number; done_cents: number; by_kind: Record<AllocationKind, number> };
export function paycheckTotals(amountCents: number, allocations: readonly Pick<PaycheckAllocation, "kind" | "amount_cents" | "done">[]): PaycheckTotals {
  const by_kind: Record<AllocationKind, number> = { bill: 0, debt: 0, spending: 0, savings: 0, other: 0 };
  let assigned = 0, done = 0;
  for (const a of allocations) {
    assigned += a.amount_cents;
    by_kind[a.kind] += a.amount_cents;
    if (a.done) done += a.amount_cents;
  }
  return { assigned_cents: assigned, left_cents: amountCents - assigned, done_cents: done, by_kind };
}
