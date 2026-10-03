/**
 * Budget planner for SPLITTER Finance (Folio "Plan").
 *
 * Categories persist across months; a BudgetMonth only stores planned income plus per-category limits.
 * Pure: integer cents, BigInt sums, no clock access (callers pass `today` as YYYY-MM-DD).
 */
import type {
  BudgetLimit,
  BudgetMonth,
  BudgetMonthInput,
  CategoryKind,
  FinanceCategory,
  FinanceSettings,
  FinanceTransaction,
} from "./finance-types.ts";
import { FINANCE_MAX_CENTS } from "./finance-types.ts";
import { monthActivity, spendingPace } from "./finance-insights.ts";
import type { SpendingPace } from "./finance-insights.ts";
import { isValidCalendarDate } from "./subscription-planner.ts";

export const MAX_BUDGET_LIMITS = 60;
export const NEAR_LIMIT_PERCENT = 85;

const MIN_YEAR = 1900;
const MAX_YEAR = 2200;
const KIND_ORDER: readonly CategoryKind[] = ["needs", "wants", "savings"];

/* ---------------------------------------------------------------- helpers */

function toSafe(value: bigint, label = "amount"): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || BigInt(n) !== value) throw new RangeError(`${label} exceeds the safe integer range`);
  return n;
}
function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= FINANCE_MAX_CENTS;
}
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function leap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function daysIn(year: number, month: number): number {
  return month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}
function compareCategories(a: FinanceCategory, b: FinanceCategory): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.sort - b.sort || cmp(a.name, b.name) || cmp(a.id, b.id);
}

/* ---------------------------------------------------------------- months */

/** True for "YYYY-MM-01" with a year from 1900 to 2200. */
export function isBudgetMonth(month: string): boolean {
  if (typeof month !== "string") return false;
  const match = /^(\d{4})-(0[1-9]|1[0-2])-01$/.exec(month);
  if (!match) return false;
  const year = Number(match[1]);
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

/** "2026-10" (an <input type="month"> value) or "2026-10-01" → "2026-10-01"; null when invalid. */
export function monthFromInput(value: string): string | null {
  if (typeof value !== "string") return null;
  const month = /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
  return isBudgetMonth(month) ? month : null;
}

export function addBudgetMonths(month: string, delta: number): string {
  if (!isBudgetMonth(month)) throw new RangeError(`Invalid budget month: ${String(month)}`);
  if (!Number.isSafeInteger(delta)) throw new RangeError("delta must be an integer");
  const zero = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  const year = Math.floor(zero / 12);
  const m = zero - year * 12 + 1;
  if (year < MIN_YEAR || year > MAX_YEAR) throw new RangeError("Budget month is outside the supported range");
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
}

/** "2024-02-01" → "2024-02-29". */
export function lastDateOfMonth(month: string): string {
  if (!isBudgetMonth(month)) throw new RangeError(`Invalid budget month: ${String(month)}`);
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return `${month.slice(0, 8)}${String(daysIn(year, m)).padStart(2, "0")}`;
}

/** The budget month containing `today` (YYYY-MM-DD). */
export function currentBudgetMonth(today: string): string {
  if (typeof today !== "string" || !isValidCalendarDate(today)) throw new RangeError(`Invalid date: ${String(today)}`);
  const month = `${today.slice(0, 7)}-01`;
  if (!isBudgetMonth(month)) throw new RangeError("Date is outside the supported budget range");
  return month;
}

/** Transactions dated inside `month`, newest first; ties broken by created_at then id (both descending). */
export function transactionsForMonth<T extends Pick<FinanceTransaction, "id" | "date" | "created_at">>(transactions: readonly T[], month: string): T[] {
  if (!isBudgetMonth(month)) return [];
  const prefix = month.slice(0, 8);
  return transactions
    .filter((t) => typeof t.date === "string" && t.date.startsWith(prefix) && isValidCalendarDate(t.date))
    .sort((a, b) => cmp(b.date, a.date) || cmp(b.created_at ?? "", a.created_at ?? "") || cmp(b.id, a.id));
}

/* ---------------------------------------------------------------- summary */

export type BudgetRowStatus = "unbudgeted" | "under" | "near" | "over" | "funded";
export type BudgetRow = {
  category: FinanceCategory;
  limit_cents: number | null;
  used_cents: number;
  remaining_cents: number | null;
  /** Whole percent of the limit used, floored (so 99.9% never shows as 100%). Null without a positive limit. */
  percent: number | null;
  status: BudgetRowStatus;
};

/** Pace over flexible spending only: wants-kind categories with a positive limit, excluding a category named "Subscriptions". Fixed bills such as rent land early in the month and would skew a straight-line projection. */
export type FlexiblePace = { planned_cents: number; spent_cents: number; category_ids: string[]; pace: SpendingPace };

export type BudgetSummary = {
  month: string;
  planned_income_cents: number;
  income_source: "budget" | "profile" | "none";
  actual_income_cents: number;
  assigned_cents: number;
  ready_to_assign_cents: number;
  spent_cents: number;
  saved_cents: number;
  left_cents: number;
  /** Sum of needs + wants limits. */
  spending_limit_cents: number;
  /** Sum of savings-kind limits. */
  savings_limit_cents: number;
  /** The spending plan the pace is measured against. */
  pace_planned_cents: number;
  rows: BudgetRow[];
  uncategorized_cents: number;
  uncategorized_count: number;
  pace: SpendingPace;
  flexible: FlexiblePace | null;
  is_set_up: boolean;
};

export type SummarizeBudgetInput = {
  month: string;
  today: string;
  budget: BudgetMonth | undefined;
  categories: FinanceCategory[];
  transactions: FinanceTransaction[];
  settings: FinanceSettings | null;
};

function rowStatus(kind: CategoryKind, limit: bigint | null, used: bigint): BudgetRowStatus {
  if (limit === null) return "unbudgeted";
  if (limit === 0n && used === 0n) return "under";
  if (kind === "savings") {
    if (used >= limit) return "funded";
    return used * 100n >= limit * BigInt(NEAR_LIMIT_PERCENT) ? "near" : "under";
  }
  if (used > limit) return "over";
  return used * 100n >= limit * BigInt(NEAR_LIMIT_PERCENT) ? "near" : "under";
}

export function summarizeBudget(input: SummarizeBudgetInput): BudgetSummary {
  const { month, today, categories, transactions, settings } = input;
  if (!isBudgetMonth(month)) throw new RangeError(`Invalid budget month: ${String(month)}`);
  if (typeof today !== "string" || !isValidCalendarDate(today)) throw new RangeError(`Invalid date: ${String(today)}`);
  // A budget row for a different month is never applied to this one.
  const budget = input.budget && input.budget.month === month ? input.budget : undefined;

  const activity = monthActivity(transactions, categories, month);
  const byId = new Map<string, FinanceCategory>();
  for (const c of categories) if (!byId.has(c.id)) byId.set(c.id, c);

  // First valid limit per known category wins.
  const limits = new Map<string, bigint>();
  for (const l of budget?.limits ?? []) {
    if (!l || !byId.has(l.category_id) || limits.has(l.category_id) || !isMoney(l.limit_cents)) continue;
    limits.set(l.category_id, BigInt(l.limit_cents));
  }

  let uncategorizedCount = 0;
  for (const t of transactions) {
    if (t.kind !== "expense" || typeof t.date !== "string" || !t.date.startsWith(month.slice(0, 8))) continue;
    if (!isValidCalendarDate(t.date)) continue;
    if (!t.category_id || !byId.has(t.category_id)) uncategorizedCount++;
  }

  const rows: BudgetRow[] = [];
  let assigned = 0n, spendingLimit = 0n, savingsLimit = 0n;
  for (const category of [...byId.values()].sort(compareCategories)) {
    const used = BigInt(activity.byCategory[category.id] ?? 0);
    const limit = limits.get(category.id) ?? null;
    const hasActivity = used > 0n;
    if (category.archived ? !hasActivity : limit === null && !hasActivity) continue;
    if (limit !== null) {
      assigned += limit;
      if (category.kind === "savings") savingsLimit += limit;
      else spendingLimit += limit;
    }
    rows.push({
      category,
      limit_cents: limit === null ? null : toSafe(limit),
      used_cents: toSafe(used),
      remaining_cents: limit === null ? null : toSafe(limit - used),
      percent: limit === null || limit === 0n ? null : toSafe((used * 100n) / limit, "percent"),
      status: rowStatus(category.kind, limit, used),
    });
  }

  let flexPlanned = 0n, flexSpent = 0n;
  const flexIds: string[] = [];
  for (const r of rows) {
    if (r.category.kind !== "wants" || r.category.archived || r.limit_cents === null || r.limit_cents <= 0) continue;
    if (r.category.name.trim().toLowerCase() === "subscriptions") continue;
    flexPlanned += BigInt(r.limit_cents);
    flexSpent += BigInt(r.used_cents);
    flexIds.push(r.category.id);
  }
  const maxCents = BigInt(FINANCE_MAX_CENTS);
  const flexible: FlexiblePace | null = flexIds.length
    ? {
        planned_cents: toSafe(flexPlanned),
        spent_cents: toSafe(flexSpent),
        category_ids: flexIds,
        pace: spendingPace({
          month, today,
          spentCents: toSafe(flexSpent > maxCents ? maxCents : flexSpent),
          plannedCents: toSafe(flexPlanned > maxCents ? maxCents : flexPlanned),
        }),
      }
    : null;

  let planned = 0n;
  let source: BudgetSummary["income_source"] = "none";
  if (budget && isMoney(budget.income_cents) && budget.income_cents > 0) {
    planned = BigInt(budget.income_cents);
    source = "budget";
  } else if (settings && isMoney(settings.monthly_net_cents) && settings.monthly_net_cents > 0) {
    planned = BigInt(settings.monthly_net_cents);
    source = "profile";
  }

  const spent = BigInt(activity.spending);
  const saved = BigInt(activity.savings);
  let pacePlanned = spendingLimit > 0n ? spendingLimit : planned - savingsLimit;
  if (pacePlanned < 0n) pacePlanned = 0n;
  if (pacePlanned > BigInt(FINANCE_MAX_CENTS)) pacePlanned = BigInt(FINANCE_MAX_CENTS);
  const pace = spendingPace({ month, today, spentCents: toSafe(spent), plannedCents: toSafe(pacePlanned) });

  return {
    month,
    planned_income_cents: toSafe(planned),
    income_source: source,
    actual_income_cents: activity.income,
    assigned_cents: toSafe(assigned),
    ready_to_assign_cents: toSafe(planned - assigned),
    spent_cents: toSafe(spent),
    saved_cents: toSafe(saved),
    left_cents: toSafe(planned - spent - saved),
    spending_limit_cents: toSafe(spendingLimit),
    savings_limit_cents: toSafe(savingsLimit),
    pace_planned_cents: toSafe(pacePlanned),
    rows,
    uncategorized_cents: activity.uncategorized,
    uncategorized_count: uncategorizedCount,
    pace,
    flexible,
    is_set_up: Boolean(budget && ((budget.limits?.length ?? 0) > 0 || (isMoney(budget.income_cents) && budget.income_cents > 0))),
  };
}

/* ---------------------------------------------------------------- insights */

export type BudgetInsight = {
  id: string;
  tone: "good" | "info" | "warn" | "bad";
  title: string;
  detail: string;
  action?: { kind: "assign" | "categorize" | "plan" | "subscriptions" | "debt"; category_id?: string };
};

export type BudgetInsightExtras = {
  subscriptionsMonthlyCents: number;
  debtMinimumsCents: number;
  categories: FinanceCategory[];
  /** Formats cents in the account currency, e.g. 4210 → "$42.10". */
  format: (cents: number) => string;
  /** "flexible" measures pace on wants categories only (see FlexiblePace). Default "all". */
  paceBasis?: "all" | "flexible";
};

export const MAX_BUDGET_INSIGHTS = 5;
/** Days into the month before the "over pace" warning is allowed. */
export const PACE_MIN_DAYS = 7;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function namedRow(summary: BudgetSummary, categories: readonly FinanceCategory[], name: string): { category: FinanceCategory | null; row: BudgetRow | null } {
  const wanted = name.toLowerCase();
  const matches = categories
    .filter((c) => !c.archived && c.name.trim().toLowerCase() === wanted)
    .sort(compareCategories);
  for (const c of matches) {
    const row = summary.rows.find((r) => r.category.id === c.id && r.limit_cents !== null);
    if (row) return { category: c, row };
  }
  return { category: matches[0] ?? null, row: null };
}

/** Short, specific suggestions for one month, most important first, at most five. */
export function budgetInsights(summary: BudgetSummary, extras: BudgetInsightExtras): BudgetInsight[] {
  const f = extras.format;
  const out: BudgetInsight[] = [];
  const current = summary.pace.status !== "past" && summary.pace.status !== "future";
  const daysLeft = summary.pace.daysLeft;

  // 1. Over-limit categories, biggest overage first.
  const over = summary.rows
    .filter((r) => r.status === "over" && r.limit_cents !== null)
    .sort((a, b) => (b.used_cents - (b.limit_cents ?? 0)) - (a.used_cents - (a.limit_cents ?? 0)) || compareCategories(a.category, b.category));
  over.slice(0, 2).forEach((r, i) => {
    const limit = r.limit_cents ?? 0;
    const extra = i === 1 && over.length > 2 ? ` ${plural(over.length - 2, "more category is", "more categories are")} over too.` : "";
    out.push({
      id: `over-${r.category.id}`,
      tone: "bad",
      title: `${r.category.name} is ${f(r.used_cents - limit)} over`,
      detail: `${f(r.used_cents)} spent against a ${f(limit)} limit. Move money from another category or ease off here.${extra}`,
      action: { kind: "assign", category_id: r.category.id },
    });
  });

  // 2. Pace for the current month.
  const plan = summary.pace_planned_cents;
  if (extras.paceBasis === "flexible") {
    const fx = summary.flexible;
    if (fx && current) {
      const p = fx.pace;
      const fplan = fx.planned_cents;
      const spent = fx.spent_cents;
      const elapsed = p.daysInMonth - p.daysLeft + 1;
      const left = p.daysLeft;
      if (p.status === "over" && elapsed >= PACE_MIN_DAYS) {
        const room = p.safePerDayCents ?? 0;
        out.push({
          id: "pace",
          tone: "warn",
          title: `Wants are on pace for ${f(p.projectedCents)}, ${f(p.projectedCents - fplan)} over plan`,
          detail: room > 0
            ? `${f(spent)} spent so far. Keep it near ${f(room)} a day for the next ${plural(left, "day")}.`
            : `${f(spent)} spent against a ${f(fplan)} wants plan, ${plural(left, "day")} to go.`,
          action: { kind: "plan" },
        });
      } else if ((p.safePerDayCents ?? 0) > 0) {
        const onTrack = p.status !== "over";
        out.push({
          id: "pace",
          tone: onTrack ? "good" : "info",
          title: `${onTrack ? "On track: about" : "About"} ${f(p.safePerDayCents ?? 0)} a day left for wants`,
          detail: `${f(spent)} of your ${f(fplan)} wants plan spent, ${plural(left, "day")} to go.`,
        });
      } else {
        out.push({
          id: "pace",
          tone: "warn",
          title: `Your ${f(fplan)} wants plan is used up with ${plural(left, "day")} left`,
          detail: `${f(spent)} spent on wants so far. Anything more comes out of another category.`,
          action: { kind: "plan" },
        });
      }
    }
  } else if (current && plan > 0) {
    const p = summary.pace;
    const elapsed = p.daysInMonth - p.daysLeft + 1;
    // A straight-line projection is noise in the first week (rent and other bills land early), so it waits until day 7.
    if (p.status === "over" && elapsed >= PACE_MIN_DAYS) {
      const room = p.safePerDayCents ?? 0;
      out.push({
        id: "pace",
        tone: "warn",
        title: `At this pace you'll spend ${f(p.projectedCents)} by month end, ${f(p.projectedCents - plan)} over plan`,
        detail: room > 0
          ? `${f(summary.spent_cents)} spent so far. Keep it near ${f(room)} a day for the next ${plural(daysLeft, "day")} to land on plan.`
          : `${f(summary.spent_cents)} spent so far against a ${f(plan)} spending plan, with ${plural(daysLeft, "day")} to go.`,
        action: { kind: "plan" },
      });
    } else if ((p.safePerDayCents ?? 0) > 0) {
      const onTrack = p.status !== "over";
      out.push({
        id: "pace",
        tone: onTrack ? "good" : "info",
        title: `${onTrack ? "On track: about" : "About"} ${f(p.safePerDayCents ?? 0)} a day left for ${plural(daysLeft, "day")}`,
        detail: `${f(summary.spent_cents)} spent of the ${f(plan)} you planned to spend this month.`,
      });
    } else {
      out.push({
        id: "pace",
        tone: "warn",
        title: `Your ${f(plan)} spending plan is used up with ${plural(daysLeft, "day")} left`,
        detail: `${f(summary.spent_cents)} spent so far. Anything more this month comes out of savings or next month.`,
        action: { kind: "plan" },
      });
    }
  }

  // 3. Near-limit categories (spending kinds only), fullest first.
  const near = summary.rows
    // Exactly at the limit (rent paid in full, say) is the plan working, not a warning.
    .filter((r) => r.status === "near" && r.category.kind !== "savings" && r.limit_cents !== null && (r.remaining_cents ?? 0) > 0)
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0) || compareCategories(a.category, b.category));
  for (const r of near.slice(0, 2)) {
    out.push({
      id: `near-${r.category.id}`,
      tone: "warn",
      title: current
        ? `${r.category.name} is at ${r.percent}% with ${plural(daysLeft, "day")} left`
        : `${r.category.name} used ${r.percent}% of its limit`,
      detail: `${f(r.remaining_cents ?? 0)} left of ${f(r.limit_cents ?? 0)}.`,
      action: { kind: "assign", category_id: r.category.id },
    });
  }

  // 4. Ready to assign / over-assigned.
  if (summary.planned_income_cents > 0 && summary.ready_to_assign_cents > 0) {
    out.push({
      id: "unassigned",
      tone: "info",
      title: `${f(summary.ready_to_assign_cents)} isn't assigned yet`,
      detail: `Give it a job: put it toward a category or savings so all ${f(summary.planned_income_cents)} has a plan.`,
      action: { kind: "assign" },
    });
  } else if (summary.planned_income_cents > 0 && summary.ready_to_assign_cents < 0) {
    out.push({
      id: "overassigned",
      tone: "warn",
      title: `You've assigned ${f(-summary.ready_to_assign_cents)} more than you expect to earn`,
      detail: `Limits add up to ${f(summary.assigned_cents)} against ${f(summary.planned_income_cents)} of income. Trim a few so the plan fits.`,
      action: { kind: "plan" },
    });
  }

  // 5. Uncategorized expenses.
  if (summary.uncategorized_count > 0) {
    out.push({
      id: "uncategorized",
      tone: "info",
      title: `${plural(summary.uncategorized_count, "expense needs", "expenses need")} a category`,
      detail: `${f(summary.uncategorized_cents)} isn't counted against any limit yet.`,
      action: { kind: "categorize" },
    });
  }

  // 6. Subscriptions average vs the Subscriptions limit.
  const subs = isMoney(extras.subscriptionsMonthlyCents) ? extras.subscriptionsMonthlyCents : 0;
  const subRow = namedRow(summary, extras.categories, "subscriptions");
  if (subs > 0 && subRow.row && subRow.row.limit_cents !== null && subs > subRow.row.limit_cents) {
    out.push({
      id: "subscriptions",
      tone: "warn",
      title: `Subscriptions average ${f(subs)} a month, ${f(subs - subRow.row.limit_cents)} over the limit`,
      detail: `Your Subscriptions limit is ${f(subRow.row.limit_cents)}. Cancel one you rarely use or raise the limit.`,
      action: { kind: "subscriptions" },
    });
  }

  // 7. Debt minimums vs the Debt payments limit.
  const minimums = isMoney(extras.debtMinimumsCents) ? extras.debtMinimumsCents : 0;
  const debtRow = namedRow(summary, extras.categories, "debt payments");
  if (minimums > 0) {
    const limit = debtRow.row?.limit_cents ?? null;
    const debtAction: BudgetInsight["action"] = debtRow.category ? { kind: "debt", category_id: debtRow.category.id } : { kind: "debt" };
    if (limit === null) {
      out.push({
        id: "debt",
        tone: "info",
        title: `Set aside ${f(minimums)} for debt minimums`,
        detail: "There's no Debt payments limit this month. Add one so minimums get paid first.",
        action: debtAction,
      });
    } else if (minimums > limit) {
      out.push({
        id: "debt",
        tone: "warn",
        title: `Debt minimums need ${f(minimums)}, ${f(minimums - limit)} more than budgeted`,
        detail: `Your Debt payments limit is ${f(limit)}. Missing a minimum costs fees and credit score.`,
        action: debtAction,
      });
    }
  }

  // 8. Savings targets reached.
  const funded = summary.rows.filter((r) => r.status === "funded" && (r.limit_cents ?? 0) > 0);
  if (funded.length > 0) {
    let target = 0n, saved = 0n;
    for (const r of funded) {
      target += BigInt(r.limit_cents ?? 0);
      saved += BigInt(r.used_cents);
    }
    out.push({
      id: "savings-funded",
      tone: "good",
      title: "Savings target reached",
      detail: `${f(toSafe(saved))} put away against a ${f(toSafe(target))} target${funded.length > 1 ? ` across ${funded.length} categories` : ""}.`,
    });
  }

  return out.slice(0, MAX_BUDGET_INSIGHTS);
}

/* ---------------------------------------------------------------- planning */

function splitEven(total: bigint, cats: FinanceCategory[]): BudgetLimit[] {
  if (cats.length === 0) return [];
  const sorted = [...cats].sort((a, b) => a.sort - b.sort || cmp(a.id, b.id));
  const n = BigInt(sorted.length);
  const base = total / n;
  const extra = Number(total % n);
  return sorted.map((c, i) => ({ category_id: c.id, limit_cents: toSafe(base + (i < extra ? 1n : 0n)) }));
}

/**
 * Warren's 50/30/20 across the user's own categories. Income splits 50/30/20 (floored, leftover cents to needs),
 * then each share splits evenly across that kind's non-archived categories (leftover cents to the first by sort, then id).
 * A kind with no categories gets nothing; its share stays unassigned.
 */
export function starterLimits(input: { incomeCents: number; categories: FinanceCategory[] }): BudgetLimit[] {
  if (!isMoney(input.incomeCents)) throw new RangeError(`Income must be an integer from 0 to ${FINANCE_MAX_CENTS} cents`);
  const income = BigInt(input.incomeCents);
  const wants = (income * 30n) / 100n;
  const savings = (income * 20n) / 100n;
  const needs = income - wants - savings;
  const active = input.categories.filter((c) => !c.archived);
  return [
    ...splitEven(needs, active.filter((c) => c.kind === "needs")),
    ...splitEven(wants, active.filter((c) => c.kind === "wants")),
    ...splitEven(savings, active.filter((c) => c.kind === "savings")),
  ];
}

/** Last month's limits for categories that still exist and are not archived. */
export function copyLimits(previous: BudgetMonth | undefined, categories: FinanceCategory[]): BudgetLimit[] {
  if (!previous) return [];
  const live = new Set(categories.filter((c) => !c.archived).map((c) => c.id));
  const seen = new Set<string>();
  const out: BudgetLimit[] = [];
  for (const l of previous.limits ?? []) {
    if (!l || !live.has(l.category_id) || seen.has(l.category_id) || !isMoney(l.limit_cents)) continue;
    seen.add(l.category_id);
    out.push({ category_id: l.category_id, limit_cents: l.limit_cents });
  }
  return out;
}

export function validateBudgetInput(input: BudgetMonthInput, categories: FinanceCategory[]): string[] {
  const errors: string[] = [];
  const maxLabel = (FINANCE_MAX_CENTS / 100).toLocaleString("en-US");
  if (!input || typeof input !== "object") return ["Budget details are missing."];
  if (!isBudgetMonth(input.month)) errors.push("Choose a valid month.");
  if (!isMoney(input.income_cents)) errors.push(`Income must be a whole number of cents from 0 to ${maxLabel}.`);
  if (!Array.isArray(input.limits)) return [...errors, "Limits are required."];
  if (input.limits.length > MAX_BUDGET_LIMITS) errors.push(`A month can have at most ${MAX_BUDGET_LIMITS} limits.`);
  const known = new Set(categories.map((c) => c.id));
  const seen = new Set<string>();
  input.limits.forEach((l, index) => {
    const label = `Limit ${index + 1}`;
    if (!l || typeof l !== "object") {
      errors.push(`${label} is missing.`);
      return;
    }
    if (typeof l.category_id !== "string" || !known.has(l.category_id)) errors.push(`${label} points to a category that doesn't exist.`);
    else if (seen.has(l.category_id)) errors.push(`${label} repeats a category that already has a limit.`);
    if (typeof l.category_id === "string") seen.add(l.category_id);
    if (!isMoney(l.limit_cents)) errors.push(`${label} must be a whole number of cents from 0 to ${maxLabel}.`);
  });
  return errors;
}
