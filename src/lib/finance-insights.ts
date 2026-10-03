/**
 * Pure finance insights for SPLITTER Finance (ported and hardened from Folio's rules.ts / ai.ts / store.ts).
 *
 * - Money is integer cents. Sums run in BigInt and are converted back only after a safe-integer check.
 * - No clock access: every function that needs "now" takes a `today` YYYY-MM-DD string.
 * - No NaN / Infinity ever reaches output; missing inputs produce `unknown` results with a `needs` hint.
 */
import type {
  AccountType,
  BudgetMonth,
  FinanceAccount,
  FinanceBundle,
  FinanceCategory,
  FinanceHolding,
  FinanceSettings,
  FinanceTransaction,
  Subscription,
} from "./finance-types.ts";
import { FINANCE_MAX_CENTS, LIQUID_TYPES, isLiability } from "./finance-types.ts";
import {
  addCalendarDays,
  budgetForChargeDate,
  isValidCalendarDate,
  nextRenewalDate,
  subscriptionEquivalentTotals,
} from "./subscription-planner.ts";

/* ---------------------------------------------------------------- helpers */

const ACCOUNT_TYPES: readonly AccountType[] = ["checking", "savings", "cash", "investment", "credit", "loan"];

function toSafe(value: bigint, label = "amount"): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || BigInt(n) !== value) throw new RangeError(`${label} exceeds the safe integer range`);
  return n;
}

function cents(value: number, label = "amount_cents"): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be an integer number of cents`);
  return BigInt(value);
}

function magnitude(value: number, label = "amount_cents"): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value > FINANCE_MAX_CENTS) {
    throw new RangeError(`${label} must be an integer from 0 to ${FINANCE_MAX_CENTS}`);
  }
  return BigInt(value);
}

/** Half-up division for non-negative numerators and positive divisors (half away from zero for negatives). */
function divHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError("divisor must be positive");
  if (n >= 0n) return (n * 2n + d) / (d * 2n);
  return -((-n * 2n + d) / (d * 2n));
}

/** Exact comparison n/d <= num/den without floating point (d, den > 0). */
function ratioAtMost(n: bigint, d: bigint, num: bigint, den: bigint): boolean {
  return n * den <= num * d;
}
function ratioAtLeast(n: bigint, d: bigint, num: bigint, den: bigint): boolean {
  return n * den >= num * d;
}

function leap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function daysIn(year: number, month: number): number {
  return month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}
function parseIso(date: string): { year: number; month: number; day: number } {
  if (!isValidCalendarDate(date)) throw new RangeError(`Invalid calendar date: ${date}`);
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) };
}

function percent(n: bigint, d: bigint): string {
  // d > 0 guaranteed by callers.
  return `${toSafe(divHalfUp(n * 100n, d), "percent")}%`;
}
function ratioNumber(n: bigint, d: bigint): number {
  const r = Number(n) / Number(d);
  return Number.isFinite(r) ? r : 0;
}

const formatterCache = new Map<string, Intl.NumberFormat | null>();
function formatter(currency: string, fractionDigits: number): Intl.NumberFormat | null {
  const key = `${currency}|${fractionDigits}`;
  if (!formatterCache.has(key)) {
    let f: Intl.NumberFormat | null = null;
    try {
      f = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      });
    } catch {
      f = null;
    }
    formatterCache.set(key, f);
  }
  return formatterCache.get(key) ?? null;
}
/** Whole currency units, e.g. "$1,850". */
function moneyWhole(valueCents: number | bigint, currency: string): string {
  const n = Number(valueCents) / 100;
  const f = formatter(currency, 0);
  return f ? f.format(n) : `${currency} ${Math.round(n)}`;
}
/** Exact to the cent, e.g. "$1,850.25". */
function moneyExact(valueCents: number | bigint, currency: string): string {
  const v = typeof valueCents === "bigint" ? valueCents : BigInt(valueCents);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const f = formatter(currency, 2);
  let body: string;
  if (f && whole <= BigInt(Number.MAX_SAFE_INTEGER) / 100n) {
    body = f.format(Number(abs) / 100);
  } else {
    body = `${currency} ${whole.toString()}.${frac.toString().padStart(2, "0")}`;
  }
  return neg ? `-${body}` : body;
}

function categoryMap(categories: readonly FinanceCategory[]): Map<string, FinanceCategory> {
  const map = new Map<string, FinanceCategory>();
  for (const c of categories) map.set(c.id, c);
  return map;
}

/* ---------------------------------------------------------------- holdings & accounts */

const SHARES_RE = /^(\d+)(?:\.(\d{1,8}))?$/;

/** Exact value of `shares` (decimal string, ≤ 8 places) × `priceCents`, rounded half-up to the cent. */
export function holdingValueCents(shares: string, priceCents: number): number {
  if (typeof shares !== "string") throw new RangeError("shares must be a decimal string");
  const match = SHARES_RE.exec(shares.trim());
  if (!match) throw new RangeError(`Invalid share quantity: ${shares}`);
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) throw new RangeError("price_cents must be a non-negative integer");
  const scaled = BigInt(match[1]) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  return toSafe(divHalfUp(scaled * BigInt(priceCents), 100_000_000n), "holding value");
}

function accountValueBig(account: FinanceAccount, holdings: readonly FinanceHolding[]): bigint {
  if (account.type === "investment") {
    const own = holdings.filter((h) => h.account_id === account.id);
    if (own.length > 0) {
      let total = 0n;
      for (const h of own) total += BigInt(holdingValueCents(h.shares, h.price_cents));
      return total;
    }
  }
  const balance = cents(account.balance_cents, "balance_cents");
  // Liabilities are amounts owed and never negative; a stray negative is treated as nothing owed.
  if (isLiability(account.type)) return balance < 0n ? 0n : balance;
  return balance;
}

/**
 * Asset accounts: amount held (may be negative for overdrawn checking).
 * Investment accounts with ≥1 holding: sum of holdings. Liabilities: amount owed (≥ 0).
 */
export function accountValueCents(account: FinanceAccount, holdings: readonly FinanceHolding[]): number {
  return toSafe(accountValueBig(account, holdings), "account value");
}

export type NetWorth = {
  assets: number;
  liabilities: number;
  net: number;
  liquid: number;
  investments: number;
  byType: Record<AccountType, number>;
};

export function netWorth(accounts: readonly FinanceAccount[], holdings: readonly FinanceHolding[]): NetWorth {
  let assets = 0n, liabilities = 0n, liquid = 0n, investments = 0n;
  const byType: Record<AccountType, bigint> = { checking: 0n, savings: 0n, cash: 0n, investment: 0n, credit: 0n, loan: 0n };
  for (const account of accounts) {
    if (!ACCOUNT_TYPES.includes(account.type)) continue;
    const value = accountValueBig(account, holdings);
    byType[account.type] += value;
    if (isLiability(account.type)) {
      liabilities += value;
    } else {
      assets += value;
      if (account.type === "investment") investments += value;
      if (LIQUID_TYPES.includes(account.type) && value > 0n) liquid += value;
    }
  }
  return {
    assets: toSafe(assets, "assets"),
    liabilities: toSafe(liabilities, "liabilities"),
    net: toSafe(assets - liabilities, "net worth"),
    liquid: toSafe(liquid, "liquid"),
    investments: toSafe(investments, "investments"),
    byType: {
      checking: toSafe(byType.checking), savings: toSafe(byType.savings), cash: toSafe(byType.cash),
      investment: toSafe(byType.investment), credit: toSafe(byType.credit), loan: toSafe(byType.loan),
    },
  };
}

/* ---------------------------------------------------------------- months */

/** "YYYY-MM-DD" (or "YYYY-MM") → "YYYY-MM-01". Throws RangeError on invalid input. */
export function monthKey(date: string): string {
  if (typeof date === "string" && /^\d{4}-\d{2}$/.test(date)) date = `${date}-01`;
  if (typeof date !== "string" || !isValidCalendarDate(date)) throw new RangeError(`Invalid date: ${String(date)}`);
  return `${date.slice(0, 7)}-01`;
}

/** Shift a month ("YYYY-MM-01" or any date in it) by `delta` months; returns "YYYY-MM-01". */
export function addMonths(month: string, delta: number): string {
  const key = monthKey(month);
  if (!Number.isSafeInteger(delta)) throw new RangeError("delta must be an integer");
  const zero = Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1) + delta;
  const year = Math.floor(zero / 12);
  const m = zero - year * 12 + 1;
  if (year < 1 || year > 9999) throw new RangeError("Month out of range");
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
}

function txMonth(t: FinanceTransaction): string | null {
  return typeof t.date === "string" && isValidCalendarDate(t.date) ? `${t.date.slice(0, 7)}-01` : null;
}

/* ---------------------------------------------------------------- activity */

export type MonthActivity = {
  income: number;
  /** needs + wants + uncategorized expenses (savings-kind categories and transfers excluded). */
  spending: number;
  /** Expenses in savings-kind categories (contributions, not spending). */
  savings: number;
  transfers: number;
  needs: number;
  wants: number;
  uncategorized: number;
  /** Expense totals keyed by category id (includes savings-kind categories; excludes uncategorized). */
  byCategory: Record<string, number>;
  /** Number of transactions of any kind dated in the month. */
  count: number;
};

type ExpenseBucket = "needs" | "wants" | "savings" | "uncategorized";
function expenseBucket(t: FinanceTransaction, cats: Map<string, FinanceCategory>): { bucket: ExpenseBucket; category: FinanceCategory | null } {
  const category = t.category_id ? cats.get(t.category_id) ?? null : null;
  if (!category) return { bucket: "uncategorized", category: null };
  return { bucket: category.kind, category };
}

export function monthActivity(
  transactions: readonly FinanceTransaction[],
  categories: readonly FinanceCategory[],
  month: string,
): MonthActivity {
  const key = monthKey(month);
  const cats = categoryMap(categories);
  let income = 0n, savings = 0n, transfers = 0n, needs = 0n, wants = 0n, uncategorized = 0n;
  const byCategory = new Map<string, bigint>();
  let count = 0;
  for (const t of transactions) {
    if (txMonth(t) !== key) continue;
    const amount = magnitude(t.amount_cents);
    count++;
    if (t.kind === "income") income += amount;
    else if (t.kind === "transfer") transfers += amount;
    else if (t.kind === "expense") {
      const { bucket, category } = expenseBucket(t, cats);
      if (bucket === "needs") needs += amount;
      else if (bucket === "wants") wants += amount;
      else if (bucket === "savings") savings += amount;
      else uncategorized += amount;
      if (category) byCategory.set(category.id, (byCategory.get(category.id) ?? 0n) + amount);
    }
  }
  const byCategoryOut: Record<string, number> = {};
  for (const [id, v] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    byCategoryOut[id] = toSafe(v);
  }
  return {
    income: toSafe(income),
    spending: toSafe(needs + wants + uncategorized),
    savings: toSafe(savings),
    transfers: toSafe(transfers),
    needs: toSafe(needs),
    wants: toSafe(wants),
    uncategorized: toSafe(uncategorized),
    byCategory: byCategoryOut,
    count,
  };
}

/** Spending (needs + wants + uncategorized expenses) per calendar day for `days` days ending at `endDate`. */
export function dailySpending(
  transactions: readonly FinanceTransaction[],
  categories: readonly FinanceCategory[],
  endDate: string,
  days = 30,
): { date: string; cents: number }[] {
  if (!isValidCalendarDate(endDate)) throw new RangeError(`Invalid end date: ${endDate}`);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 3660) throw new RangeError("days must be an integer from 1 to 3660");
  const start = addCalendarDays(endDate, -(days - 1));
  if (!start) throw new RangeError("Date window out of range");
  const cats = categoryMap(categories);
  const totals = new Map<string, bigint>();
  for (const t of transactions) {
    if (t.kind !== "expense" || typeof t.date !== "string" || !isValidCalendarDate(t.date)) continue;
    if (t.date < start || t.date > endDate) continue;
    const amount = magnitude(t.amount_cents);
    if (expenseBucket(t, cats).bucket === "savings") continue;
    totals.set(t.date, (totals.get(t.date) ?? 0n) + amount);
  }
  const out: { date: string; cents: number }[] = [];
  for (let i = 0; i < days; i++) {
    const date = addCalendarDays(start, i);
    if (!date) throw new RangeError("Date window out of range");
    out.push({ date, cents: toSafe(totals.get(date) ?? 0n) });
  }
  return out;
}

/**
 * Mean monthly spending over the last `months` complete calendar months before the month of `today`,
 * skipping months in that window with no transactions at all. Half-up to the cent. Null when none qualify.
 */
export function averageMonthlySpending(
  transactions: readonly FinanceTransaction[],
  categories: readonly FinanceCategory[],
  today: string,
  months = 3,
): number | null {
  const current = monthKey(today);
  if (!Number.isSafeInteger(months) || months <= 0 || months > 1200) throw new RangeError("months must be an integer from 1 to 1200");
  let total = 0n;
  let used = 0;
  for (let i = 1; i <= months; i++) {
    let key: string;
    try {
      key = addMonths(current, -i);
    } catch {
      break;
    }
    const activity = monthActivity(transactions, categories, key);
    if (activity.count === 0) continue;
    total += BigInt(activity.spending);
    used++;
  }
  if (used === 0) return null;
  return toSafe(divHalfUp(total, BigInt(used)), "average spending");
}

/* ---------------------------------------------------------------- health rules */

export type RuleStatus = "pass" | "warn" | "fail" | "unknown";
export type RuleId = "50-30-20" | "housing" | "car" | "dti" | "emergency" | "savings-rate";
export type RuleResult = {
  id: RuleId;
  name: string;
  status: RuleStatus;
  actual: string;
  target: string;
  detail: string;
  ratio: number | null;
  needs: string | null;
};

export type HealthInput = {
  settings: FinanceSettings | null;
  accounts: readonly FinanceAccount[];
  holdings: readonly FinanceHolding[];
  categories: readonly FinanceCategory[];
  transactions: readonly FinanceTransaction[];
  today: string;
  currency: string;
};

function namedCategorySpend(activity: MonthActivity, categories: readonly FinanceCategory[], name: string): bigint {
  let total = 0n;
  const wanted = name.toLowerCase();
  for (const c of categories) {
    if (c.kind === "savings" || c.name.trim().toLowerCase() !== wanted) continue;
    total += BigInt(activity.byCategory[c.id] ?? 0);
  }
  return total;
}

function profileCents(settings: FinanceSettings | null, key: "monthly_gross_cents" | "monthly_net_cents" | "housing_cents" | "car_cents"): bigint {
  if (!settings) return 0n;
  const v = settings[key];
  if (!Number.isSafeInteger(v) || v < 0) return 0n;
  return BigInt(v);
}

/** pass when ratio ≤ good, warn when ≤ ok, else fail. Thresholds in percent. */
function band(n: bigint, d: bigint, goodPct: number, okPct: number): RuleStatus {
  if (ratioAtMost(n, d, BigInt(goodPct), 100n)) return "pass";
  if (ratioAtMost(n, d, BigInt(okPct), 100n)) return "warn";
  return "fail";
}

const NEED_INCOME = "Add your monthly take-home pay or log this month's income to check this.";
const NEED_GROSS = "Add your monthly gross (pre-tax) income to check this.";

/** Folio's six rules for the calendar month containing `today`. */
export function evaluateHealth(input: HealthInput): RuleResult[] {
  const { settings, accounts, holdings, categories, transactions, today, currency } = input;
  const month = monthKey(today);
  const activity = monthActivity(transactions, categories, month);
  const fmt = (v: bigint | number) => moneyWhole(v, currency);

  const loggedIncome = BigInt(activity.income);
  const profileNet = profileCents(settings, "monthly_net_cents");
  const income = loggedIncome > 0n ? loggedIncome : profileNet;
  const incomeSource = loggedIncome > 0n ? "this month's logged income" : "your profile take-home pay";
  const gross = profileCents(settings, "monthly_gross_cents");

  const needs = BigInt(activity.needs);
  const wants = BigInt(activity.wants);
  const saved = BigInt(activity.savings);
  const uncategorized = BigInt(activity.uncategorized);
  const spending = BigInt(activity.spending);

  const profileHousing = profileCents(settings, "housing_cents");
  const housing = profileHousing > 0n ? profileHousing : namedCategorySpend(activity, categories, "housing");
  const car = profileCents(settings, "car_cents");
  const transport = namedCategorySpend(activity, categories, "transport") + car;

  const results: RuleResult[] = [];

  /* 50 / 30 / 20 */
  {
    const uncatNote = uncategorized > 0n
      ? ` ${fmt(uncategorized)} of uncategorized spending is not counted as needs or wants; categorize it for an accurate split.`
      : "";
    const base: Omit<RuleResult, "status" | "actual" | "ratio" | "needs"> = {
      id: "50-30-20",
      name: "50 / 30 / 20",
      target: "50% needs · 30% wants · 20% savings",
      detail: `Elizabeth Warren's rule on take-home pay: needs first, then fun, then future. If housing is expensive, 60/30/10 is the honest fallback.${uncatNote}`,
    };
    if (income <= 0n) {
      results.push({ ...base, status: "unknown", actual: "No take-home income yet", ratio: null, needs: NEED_INCOME });
    } else {
      const status: RuleStatus =
        ratioAtMost(needs, income, 55n, 100n) && ratioAtLeast(saved, income, 15n, 100n)
          ? "pass"
          : ratioAtMost(needs, income, 65n, 100n)
            ? "warn"
            : "fail";
      const uncatPart = uncategorized > 0n ? ` · ${percent(uncategorized, income)} uncategorized` : "";
      results.push({
        ...base,
        detail: `${base.detail} Based on ${incomeSource}.`,
        status,
        actual: `${percent(needs, income)} needs · ${percent(wants, income)} wants · ${percent(saved, income)} saved${uncatPart}`,
        ratio: ratioNumber(needs, income),
        needs: null,
      });
    }
  }

  /* Housing */
  {
    const base = {
      id: "housing" as const,
      name: "Housing ≤ 28-30%",
      target: "≤ 28% of gross front-end, ≤ 36% with other debts",
      detail: `Mortgage underwriters use 28% of gross for housing (rent or PITI) and 36% back-end. Stay under 30% of take-home if you can.${profileHousing > 0n ? "" : " Using this month's spending in your Housing category because no housing payment is set."}`,
    };
    if (gross <= 0n) {
      results.push({ ...base, status: "unknown", actual: `${fmt(housing)} / mo housing`, ratio: null, needs: NEED_GROSS });
    } else {
      results.push({
        ...base,
        status: band(housing, gross, 28, 36),
        actual: `${percent(housing, gross)} of gross (${fmt(housing)} / mo)`,
        ratio: ratioNumber(housing, gross),
        needs: null,
      });
    }
  }

  /* Car 20 / 4 / 10 */
  {
    const base = {
      id: "car" as const,
      name: "Car 20 / 4 / 10",
      target: "20% down · ≤ 4-year loan · transport ≤ 10% of take-home",
      detail: "Put 20% down, never finance longer than 48 months, and keep car payment, insurance, fuel and parking under 10% of monthly take-home.",
    };
    if (transport === 0n) {
      results.push({ ...base, status: "pass", actual: "No car costs logged this month", ratio: 0, needs: null });
    } else if (income <= 0n) {
      results.push({ ...base, status: "unknown", actual: `${fmt(car)} payment · ${fmt(transport)} all-in transport`, ratio: null, needs: NEED_INCOME });
    } else {
      results.push({
        ...base,
        status: band(transport, income, 10, 15),
        actual: `${fmt(car)} payment · ${fmt(transport)} all-in transport (${percent(transport, income)})`,
        ratio: ratioNumber(transport, income),
        needs: null,
      });
    }
  }

  /* Debt-to-income */
  {
    let minimums = 0n;
    for (const a of accounts) {
      if (!isLiability(a.type)) continue;
      if (!Number.isSafeInteger(a.balance_cents) || a.balance_cents <= 0) continue;
      if (a.minimum_cents !== null && Number.isSafeInteger(a.minimum_cents) && a.minimum_cents > 0) minimums += BigInt(a.minimum_cents);
    }
    const debtPay = minimums + housing + car;
    const base = {
      id: "dti" as const,
      name: "Debt-to-income",
      target: "≤ 36% preferred · 43% conventional ceiling",
      detail: "Monthly debt payments (card and loan minimums, housing, car) ÷ gross income. Lenders prefer ≤ 36%; above 43% most conventional mortgages get hard.",
    };
    if (gross <= 0n) {
      results.push({ ...base, status: "unknown", actual: `${fmt(debtPay)} / mo in debt payments`, ratio: null, needs: NEED_GROSS });
    } else {
      results.push({
        ...base,
        status: band(debtPay, gross, 36, 43),
        actual: `${percent(debtPay, gross)} back-end DTI (${fmt(debtPay)} / mo)`,
        ratio: ratioNumber(debtPay, gross),
        needs: null,
      });
    }
  }

  /* Emergency fund */
  {
    const liquid = BigInt(netWorth(accounts, holdings).liquid);
    const avg = averageMonthlySpending(transactions, categories, today);
    let burn = 0n;
    let burnSource = "";
    if (avg !== null && avg > 0) {
      burn = BigInt(avg);
      burnSource = "average monthly spending over recent complete months";
    } else if (spending > 0n) {
      burn = spending;
      burnSource = "this month's spending so far (no complete month of history yet)";
    }
    const base = {
      id: "emergency" as const,
      name: "Emergency fund",
      target: "3-6 months of essential expenses",
      detail: "Cash and savings only, not investments. Three months if your job is stable, six if income is lumpy.",
    };
    if (burn <= 0n) {
      results.push({ ...base, status: "unknown", actual: `${fmt(liquid)} in cash`, ratio: null, needs: "Log a month of spending to check this." });
    } else {
      const status: RuleStatus = liquid >= burn * 3n ? "pass" : liquid >= burn ? "warn" : "fail";
      // Tenths of a month, floored so the label never overstates coverage.
      const tenths = (liquid * 10n) / burn;
      const months = Number(tenths) / 10;
      results.push({
        ...base,
        detail: `${base.detail} Measured against ${burnSource}.`,
        status,
        actual: `${months.toFixed(1)} months of spending in cash`,
        ratio: ratioNumber(liquid, burn * 6n),
        needs: null,
      });
    }
  }

  /* Savings rate */
  {
    const base = {
      id: "savings-rate" as const,
      name: "Savings rate",
      target: "≥ 20% (15% retirement minimum)",
      detail: "Pay yourself first: expenses in Savings-type categories count as contributions. High-APR debt above ~8% usually beats investing the same dollar.",
    };
    if (income <= 0n) {
      results.push({ ...base, status: "unknown", actual: `${fmt(saved)} saved this month`, ratio: null, needs: NEED_INCOME });
    } else {
      const status: RuleStatus = ratioAtLeast(saved, income, 20n, 100n) ? "pass" : ratioAtLeast(saved, income, 10n, 100n) ? "warn" : "fail";
      results.push({
        ...base,
        status,
        actual: `${percent(saved, income)} of this month's income`,
        ratio: ratioNumber(saved, income),
        needs: null,
      });
    }
  }

  return results;
}

/** pass = 1, warn = 0.5, fail = 0, averaged over known rules → 0-100. Null when every rule is unknown. */
export function healthScore(results: readonly Pick<RuleResult, "status">[]): number | null {
  let halfPoints = 0;
  let known = 0;
  for (const r of results) {
    if (r.status === "unknown") continue;
    known++;
    halfPoints += r.status === "pass" ? 2 : r.status === "warn" ? 1 : 0;
  }
  if (known === 0) return null;
  return Math.round((halfPoints * 100) / (known * 2));
}

/* ---------------------------------------------------------------- spending pace */

export type SpendingPace = {
  daysInMonth: number;
  daysLeft: number;
  projectedCents: number;
  safePerDayCents: number | null;
  status: "under" | "on-track" | "over" | "past" | "future";
};

export function spendingPace(input: { month: string; today: string; spentCents: number; plannedCents: number }): SpendingPace {
  const key = monthKey(input.month);
  const t = parseIso(input.today);
  const spent = magnitude(input.spentCents, "spentCents");
  const planned = magnitude(input.plannedCents, "plannedCents");
  const year = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const dim = daysIn(year, m);
  const todayKey = monthKey(input.today);
  if (todayKey < key) return { daysInMonth: dim, daysLeft: dim, projectedCents: toSafe(spent), safePerDayCents: null, status: "future" };
  if (todayKey > key) return { daysInMonth: dim, daysLeft: 0, projectedCents: toSafe(spent), safePerDayCents: null, status: "past" };
  const elapsed = BigInt(t.day);
  const daysLeft = dim - t.day + 1;
  const projected = divHalfUp(spent * BigInt(dim), elapsed);
  const remaining = planned > spent ? planned - spent : 0n;
  const safePerDay = remaining / BigInt(daysLeft);
  const status: SpendingPace["status"] =
    projected * 100n < planned * 95n ? "under" : projected * 100n > planned * 105n ? "over" : "on-track";
  return { daysInMonth: dim, daysLeft, projectedCents: toSafe(projected), safePerDayCents: toSafe(safePerDay), status };
}

/* ---------------------------------------------------------------- AI context */

export const AI_SYSTEM_PROMPT = [
  "You are a concise personal CFO inside SPLITTER Finance.",
  "Use only the ledger supplied in the user message. Never invent balances, transactions, rates or income.",
  "Answer with a verdict first, then the 2-3 numbers that support it, then one concrete next action.",
  "If the data needed to answer is missing, say exactly what is missing instead of guessing.",
  "This is general information, not formal financial, tax or legal advice.",
  "Reply in plain text: short sentences, no tables, no markdown headings.",
].join(" ");

export const AI_CONTEXT_MAX_CHARS = 12_000;
const AI_RECENT_TRANSACTIONS = 40;

/** Single-line, length-capped user text so free-form fields cannot reshape the context. */
function clean(text: string | null | undefined, max = 80): string {
  const s = String(text ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildAiContext(bundle: FinanceBundle, today: string): string {
  const settings = bundle.settings;
  const currency = settings?.currency || "USD";
  const money = (v: number | bigint) => moneyExact(v, currency);
  const month = monthKey(today);
  const cats = categoryMap(bundle.categories);
  const lines: string[] = [];

  lines.push(`Today: ${today}`);
  lines.push(`Currency: ${clean(currency, 8)}`);
  if (settings) {
    const p = (v: number) => (Number.isSafeInteger(v) && v > 0 ? money(v) : "not set");
    lines.push(
      `Profile (monthly): gross ${p(settings.monthly_gross_cents)}, take-home ${p(settings.monthly_net_cents)}, housing ${p(settings.housing_cents)}, car ${p(settings.car_cents)}`,
    );
  } else {
    lines.push("Profile: not provided");
  }

  const worth = netWorth(bundle.accounts, bundle.holdings);
  lines.push(
    `Net worth ${money(worth.net)} (assets ${money(worth.assets)}, liabilities ${money(worth.liabilities)}), liquid cash ${money(worth.liquid)}, investments ${money(worth.investments)}`,
  );

  const accounts = [...bundle.accounts]
    .filter((a) => ACCOUNT_TYPES.includes(a.type))
    .sort((a, b) => ACCOUNT_TYPES.indexOf(a.type) - ACCOUNT_TYPES.indexOf(b.type) || cmp(a.name, b.name) || cmp(a.id, b.id));
  const assetAccounts = accounts.filter((a) => !isLiability(a.type));
  const liabilityAccounts = accounts.filter((a) => isLiability(a.type));
  lines.push(
    `Accounts: ${
      assetAccounts.length
        ? assetAccounts
            .map((a) => `${clean(a.name)} (${a.type}${a.institution.trim() ? `, ${clean(a.institution, 40)}` : ""}) ${money(accountValueCents(a, bundle.holdings))}`)
            .join("; ")
        : "none"
    }`,
  );
  lines.push(
    `Liabilities: ${
      liabilityAccounts.length
        ? liabilityAccounts
            .map((a) => {
              const apr = a.apr_bps !== null && Number.isSafeInteger(a.apr_bps) && a.apr_bps >= 0 ? `${(a.apr_bps / 100).toFixed(2)}% APR` : "APR unknown";
              const min = a.minimum_cents !== null && Number.isSafeInteger(a.minimum_cents) && a.minimum_cents >= 0 ? `min ${money(a.minimum_cents)}/mo` : "min unknown";
              return `${clean(a.name)} (${a.type}${a.institution.trim() ? `, ${clean(a.institution, 40)}` : ""}) owes ${money(accountValueCents(a, bundle.holdings))}, ${apr}, ${min}`;
            })
            .join("; ")
        : "none"
    }`,
  );

  const activity = monthActivity(bundle.transactions, bundle.categories, month);
  lines.push(
    `This month (${month.slice(0, 7)}): income ${money(activity.income)}, spending ${money(activity.spending)} (needs ${money(activity.needs)}, wants ${money(activity.wants)}, uncategorized ${money(activity.uncategorized)}), saved ${money(activity.savings)}, transfers ${money(activity.transfers)}`,
  );

  const budget: BudgetMonth | undefined = budgetForChargeDate(bundle.budgets, `${month.slice(0, 7)}-01`);
  const limits = new Map<string, number>();
  if (budget) for (const l of budget.limits) if (Number.isSafeInteger(l.limit_cents)) limits.set(l.category_id, l.limit_cents);
  const catRows = [...bundle.categories]
    .filter((c) => (activity.byCategory[c.id] ?? 0) > 0 || limits.has(c.id))
    .sort((a, b) => a.sort - b.sort || cmp(a.name, b.name) || cmp(a.id, b.id))
    .map((c) => {
      const spent = activity.byCategory[c.id] ?? 0;
      const limit = limits.get(c.id);
      return `${clean(c.name, 40)} (${c.kind}) ${money(spent)}${limit !== undefined ? ` of ${money(limit)} limit` : ""}`;
    });
  if (budget) lines.push(`Budget this month: planned income ${money(budget.income_cents)}`);
  lines.push(`Category spend this month${budget ? " vs budget" : " (no budget set)"}: ${catRows.length ? catRows.join("; ") : "none"}`);

  const rules = evaluateHealth({
    settings,
    accounts: bundle.accounts,
    holdings: bundle.holdings,
    categories: bundle.categories,
    transactions: bundle.transactions,
    today,
    currency,
  });
  const score = healthScore(rules);
  lines.push(`Health score: ${score === null ? "unknown (not enough data)" : `${score}/100`}`);
  for (const r of rules) {
    lines.push(`Rule ${r.name}: ${r.status} · ${r.actual} · target ${r.target}${r.needs ? ` · missing: ${r.needs}` : ""}`);
  }

  const subs = [...bundle.subscriptions]
    .filter((s) => s.status === "active")
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
  if (subs.length) {
    const eq = subscriptionEquivalentTotals(subs);
    lines.push(
      `Active subscriptions (≈${money(toSafe(eq.monthly_cents))}/mo, ${money(toSafe(eq.yearly_cents))}/yr): ${subs
        .map((s: Subscription) => `${clean(s.name, 40)} ${money(s.amount_cents)} ${s.cycle}, next ${nextRenewalDate(s.anchor_date, s.cycle, today) ?? "unknown"}`)
        .join("; ")}`,
    );
  } else {
    lines.push("Active subscriptions: none");
  }

  const recent = [...bundle.transactions]
    .filter((t) => typeof t.date === "string" && isValidCalendarDate(t.date))
    .sort((a, b) => cmp(b.date, a.date) || cmp(b.created_at ?? "", a.created_at ?? "") || cmp(b.id, a.id))
    .slice(0, AI_RECENT_TRANSACTIONS);
  const txLines = recent.map((t) => {
    const amount = money(t.amount_cents);
    const signed = t.kind === "income" ? `+${amount}` : t.kind === "expense" ? `-${amount}` : `transfer ${amount}`;
    const label =
      t.kind === "income" ? "Income" : t.kind === "transfer" ? "Transfer" : (t.category_id && cats.get(t.category_id)?.name) || "Uncategorized";
    return `${t.date} ${signed} ${clean(label, 40)} ${clean(t.description)}${t.pending ? " (pending)" : ""}`;
  });

  const head = lines.join("\n");
  const assemble = (n: number) =>
    `${head}\nRecent transactions (${n} of ${bundle.transactions.length}, newest first):${n ? `\n${txLines.slice(0, n).join("\n")}` : " none"}`;
  let n = txLines.length;
  let out = assemble(n);
  while (out.length > AI_CONTEXT_MAX_CHARS && n > 0) {
    n--;
    out = assemble(n);
  }
  if (out.length > AI_CONTEXT_MAX_CHARS) out = `${out.slice(0, AI_CONTEXT_MAX_CHARS - 1)}…`;
  return out;
}
