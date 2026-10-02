import type {
  BudgetCategory,
  BudgetKind,
  BudgetMonth,
  BudgetMonthInput,
  BudgetTransaction,
  PersonalDebt,
  Subscription,
} from './finance-types';

export const MONEY_MAX = 1_000_000_000_000;
export const MAX_BUDGET_CATEGORIES = 30;
export const NEAR_CAP_PERCENT = 80;

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])-01$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BudgetCategorySummary = BudgetCategory & {
  used_cents: number;
  spending_cents: number;
  savings_contributions_cents: number;
  remaining_cents: number;
  percent_used: number;
  status: 'unused' | 'ok' | 'near' | 'over';
};

export type BudgetAdvice = {
  id: string;
  tone: 'info' | 'warning' | 'danger' | 'success';
  title: string;
  detail: string;
};

export type BudgetSummary = {
  month: string;
  income_cents: number;
  allocated_cents: number;
  unassigned_cents: number;
  used_cents: number;
  spending_cents: number;
  savings_contributions_cents: number;
  remaining_income_cents: number;
  uncategorized_cents: number;
  uncategorized_count: number;
  transaction_count: number;
  subscription_average_cents: number;
  debt_minimums_cents: number;
  category_summaries: BudgetCategorySummary[];
  advice: BudgetAdvice[];
  issues: string[];
};

export type StarterAllocation = {
  needs_cents: number;
  wants_cents: number;
  savings_cents: number;
};

export function isSafeMoney(value: unknown, allowZero = true): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= (allowZero ? 0 : 1)
    && value <= MONEY_MAX;
}

export function isBudgetMonth(month: string): boolean {
  const match = MONTH_RE.exec(month);
  if (!match) return false;
  const year = Number(match[1]);
  return year >= 1900 && year <= 2200;
}

export function isISODate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  if (year < 1900 || year > 2200) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function monthFromInput(value: string): string | null {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? `${value}-01` : value;
  return isBudgetMonth(month) ? month : null;
}

export function addBudgetMonths(month: string, delta: number): string {
  if (!isBudgetMonth(month) || !Number.isInteger(delta)) throw new Error('Invalid budget month');
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1 + delta;
  const nextYear = year + Math.floor(monthIndex / 12);
  const nextMonth = ((monthIndex % 12) + 12) % 12;
  if (nextYear < 0 || nextYear > 9999) throw new Error('Budget month is outside the supported range');
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth + 1).padStart(2, '0')}-01`;
}

export function lastDateOfBudgetMonth(month: string): string {
  const next = addBudgetMonths(month, 1);
  const end = new Date(`${next}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

export function dateIsInBudgetMonth(date: string, month: string): boolean {
  if (!isISODate(date) || !isBudgetMonth(month)) return false;
  return date >= month && date < addBudgetMonths(month, 1);
}

export function transactionsForMonth(transactions: BudgetTransaction[], month: string): BudgetTransaction[] {
  return isBudgetMonth(month) ? transactions.filter((transaction) => dateIsInBudgetMonth(transaction.expense_date, month)) : [];
}

/** Largest-remainder allocation. Every cent is assigned and ties keep 50, 30, 20 order. */
export function allocate503020(incomeCents: number): StarterAllocation {
  if (!isSafeMoney(incomeCents)) throw new RangeError(`Income must be an integer from 0 to ${MONEY_MAX} cents`);
  const weights = [50n, 30n, 20n] as const;
  const total = BigInt(incomeCents);
  const rows = weights.map((weight, index) => ({
    index,
    value: (total * weight) / 100n,
    remainder: (total * weight) % 100n,
  }));
  let left = total - rows.reduce((sum, row) => sum + row.value, 0n);
  const order = [...rows].sort((a, b) => Number(b.remainder - a.remainder) || a.index - b.index);
  for (let index = 0; left > 0n; index = (index + 1) % order.length) {
    order[index].value += 1n;
    left -= 1n;
  }
  return {
    needs_cents: Number(rows[0].value),
    wants_cents: Number(rows[1].value),
    savings_cents: Number(rows[2].value),
  };
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  throw new Error('Secure UUID generation is unavailable');
}

export function starter503020Categories(incomeCents: number, makeId: () => string = randomId): BudgetCategory[] {
  const allocation = allocate503020(incomeCents);
  return [
    { id: makeId(), name: 'Needs', kind: 'needs', limit_cents: allocation.needs_cents },
    { id: makeId(), name: 'Wants', kind: 'wants', limit_cents: allocation.wants_cents },
    { id: makeId(), name: 'Savings', kind: 'savings', limit_cents: allocation.savings_cents },
  ];
}

/** Copy names, kinds, limits, and income while issuing new IDs for the new month. */
export function copyBudgetMonth(source: Pick<BudgetMonth, 'income_cents' | 'categories'>, month: string, makeId: () => string = randomId): BudgetMonthInput {
  if (!isBudgetMonth(month)) throw new Error('Invalid destination month');
  return {
    month,
    income_cents: source.income_cents,
    categories: source.categories.map((category) => ({ ...category, id: makeId() })),
  };
}

export function validateBudgetInput(input: BudgetMonthInput): string[] {
  const errors: string[] = [];
  if (!isBudgetMonth(input.month)) errors.push('Choose a valid month.');
  if (!isSafeMoney(input.income_cents)) errors.push(`Income must be between 0 and ${MONEY_MAX} cents.`);
  if (!Array.isArray(input.categories)) return [...errors, 'Categories are required.'];
  if (input.categories.length > MAX_BUDGET_CATEGORIES) errors.push(`A budget can have at most ${MAX_BUDGET_CATEGORIES} categories.`);
  const ids = new Set<string>();
  input.categories.forEach((category, index) => {
    const label = `Category ${index + 1}`;
    if (!isUuid(category.id)) errors.push(`${label} needs a valid UUID.`);
    else if (ids.has(category.id)) errors.push(`${label} reuses another category ID.`);
    ids.add(category.id);
    if (!category.name.trim()) errors.push(`${label} needs a name.`);
    if (!(['needs', 'wants', 'savings'] as BudgetKind[]).includes(category.kind)) errors.push(`${label} has an invalid kind.`);
    if (!isSafeMoney(category.limit_cents)) errors.push(`${label} limit must be between 0 and ${MONEY_MAX} cents.`);
  });
  return errors;
}

export function validateTransactionForMonth(input: {
  amount_cents: number;
  expense_date: string;
  category_id?: string | null;
}, month: string, today: string, categoryIds?: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  if (!isSafeMoney(input.amount_cents, false)) errors.push(`Amount must be between 1 and ${MONEY_MAX} cents.`);
  if (!dateIsInBudgetMonth(input.expense_date, month)) errors.push('Date must be inside the selected month.');
  if (!isISODate(today) || input.expense_date > today) errors.push('Date cannot be in the future.');
  if (input.category_id && categoryIds && !categoryIds.has(input.category_id)) errors.push('Choose a category from this month or leave it uncategorized.');
  return errors;
}

function safeNumber(value: bigint, issues: string[], label: string): number {
  if (value > SAFE_MAX) {
    issues.push(`${label} exceeded the safe aggregate range and was capped for display.`);
    return Number.MAX_SAFE_INTEGER;
  }
  if (value < -SAFE_MAX) {
    issues.push(`${label} exceeded the safe aggregate range and was capped for display.`);
    return -Number.MAX_SAFE_INTEGER;
  }
  return Number(value);
}

function sumBig(values: Iterable<number>): bigint {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return total;
}

function subscriptionMonthlyAmount(subscription: Subscription): bigint | null {
  if (subscription.status !== 'active' || !isSafeMoney(subscription.amount_cents)) return null;
  const amount = BigInt(subscription.amount_cents);
  switch (subscription.cycle) {
    case 'weekly': return (amount * 52n + 6n) / 12n;
    case 'monthly': return amount;
    case 'quarterly': return (amount + 1n) / 3n;
    case 'yearly': return (amount + 6n) / 12n;
    default: return null;
  }
}

export function monthlySubscriptionAverage(subscriptions: Subscription[], issues: string[] = []): number {
  let total = 0n;
  for (const subscription of subscriptions) {
    const amount = subscriptionMonthlyAmount(subscription);
    if (amount === null) {
      if (subscription.status === 'active') issues.push(`Subscription ${subscription.name || subscription.id} has an unsafe amount or cycle and was ignored.`);
      continue;
    }
    total += amount;
  }
  return safeNumber(total, issues, 'Subscription average');
}

export function debtMinimumTotal(debts: PersonalDebt[], issues: string[] = []): number {
  const valid: number[] = [];
  for (const debt of debts) {
    if (!isSafeMoney(debt.minimum_cents)) {
      issues.push(`Debt ${debt.name || debt.id} has an unsafe minimum and was ignored.`);
      continue;
    }
    valid.push(debt.minimum_cents);
  }
  return safeNumber(sumBig(valid), issues, 'Debt minimum total');
}

function makeAdvice(summary: Omit<BudgetSummary, 'advice'>): BudgetAdvice[] {
  const advice: BudgetAdvice[] = [];
  if (summary.unassigned_cents < 0) {
    advice.push({ id: 'overallocated', tone: 'danger', title: 'Plan is overallocated', detail: 'Reduce category limits until planned allocations fit take-home income.' });
  } else if (summary.unassigned_cents > 0) {
    advice.push({ id: 'unassigned', tone: 'info', title: 'Income is still unassigned', detail: 'Give the remaining income a category before the month gets busy.' });
  }
  if (summary.uncategorized_count > 0) {
    advice.push({ id: 'uncategorized', tone: 'warning', title: 'Categorize recent expenses', detail: `${summary.uncategorized_count} logged expense${summary.uncategorized_count === 1 ? '' : 's'} currently sit outside the category plan.` });
  }
  for (const category of summary.category_summaries) {
    if (category.status === 'over') advice.push(category.kind === 'savings'
      ? { id: `over-${category.id}`, tone: 'success', title: `${category.name} passed its target`, detail: 'Contributions are above the planned savings target. Raise the target if you want the plan to reflect that progress.' }
      : { id: `over-${category.id}`, tone: 'danger', title: `${category.name} is over its limit`, detail: 'Pause optional spending here or move planned dollars from another category.' });
    else if (category.status === 'near') advice.push({ id: `near-${category.id}`, tone: 'warning', title: `${category.name} is near its limit`, detail: category.kind === 'savings' ? 'The savings target is nearly funded.' : 'Review remaining purchases before logging more in this category.' });
  }
  if (summary.subscription_average_cents > 0) advice.push({ id: 'subscriptions', tone: 'info', title: 'Review recurring costs', detail: 'The active subscription monthly average is a planning reminder only. It is not subtracted unless you log the charges as transactions.' });
  if (summary.debt_minimums_cents > 0) advice.push({ id: 'debt-minimums', tone: 'info', title: 'Reserve for debt minimums', detail: 'Debt minimums are a planning reminder only. They are not silently subtracted from this budget.' });
  if (!advice.length && summary.transaction_count > 0) advice.push({ id: 'on-track', tone: 'success', title: 'Plan is on track', detail: 'Logged activity is within the category limits for this month.' });
  return advice;
}

export function summarizeBudgetMonth(options: {
  month: string;
  budget?: Pick<BudgetMonth, 'month' | 'income_cents' | 'categories'> | null;
  transactions: BudgetTransaction[];
  subscriptions?: Subscription[];
  debts?: PersonalDebt[];
}): BudgetSummary {
  const issues: string[] = [];
  const month = isBudgetMonth(options.month) ? options.month : '0000-01-01';
  if (!isBudgetMonth(options.month)) issues.push('The selected month is invalid.');
  const budget = options.budget?.month === options.month ? options.budget : null;
  const income = budget && isSafeMoney(budget.income_cents) ? budget.income_cents : 0;
  if (budget && !isSafeMoney(budget.income_cents)) issues.push('Income has an unsafe value and was treated as zero.');

  const categories: BudgetCategory[] = [];
  const seen = new Set<string>();
  for (const category of budget?.categories ?? []) {
    if (categories.length >= MAX_BUDGET_CATEGORIES) {
      issues.push(`Only the first ${MAX_BUDGET_CATEGORIES} categories were summarized.`);
      break;
    }
    if (!category.id || seen.has(category.id)) {
      issues.push('A missing or duplicate category ID was ignored.');
      continue;
    }
    seen.add(category.id);
    if (!isSafeMoney(category.limit_cents)) issues.push(`${category.name || 'A category'} has an unsafe limit and its limit was treated as zero.`);
    categories.push({
      ...category,
      name: category.name || 'Unnamed category',
      kind: (['needs', 'wants', 'savings'] as BudgetKind[]).includes(category.kind) ? category.kind : 'needs',
      limit_cents: isSafeMoney(category.limit_cents) ? category.limit_cents : 0,
    });
  }

  const usedByCategory = new Map(categories.map((category) => [category.id, 0n]));
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  let spending = 0n;
  let savings = 0n;
  let uncategorized = 0n;
  let uncategorizedCount = 0;
  let transactionCount = 0;

  for (const transaction of transactionsForMonth(options.transactions, options.month)) {
    if (!isSafeMoney(transaction.amount_cents, false)) {
      issues.push(`Transaction ${transaction.description || transaction.id} has an unsafe amount and was ignored.`);
      continue;
    }
    transactionCount += 1;
    const amount = BigInt(transaction.amount_cents);
    const category = transaction.category_id ? categoryById.get(transaction.category_id) : undefined;
    if (!category) {
      uncategorized += amount;
      uncategorizedCount += 1;
      spending += amount;
      continue;
    }
    usedByCategory.set(category.id, (usedByCategory.get(category.id) ?? 0n) + amount);
    if (category.kind === 'savings') savings += amount;
    else spending += amount;
  }

  const categorySummaries = categories.map((category): BudgetCategorySummary => {
    const usedBig = usedByCategory.get(category.id) ?? 0n;
    const used = safeNumber(usedBig, issues, `${category.name} activity`);
    const remaining = safeNumber(BigInt(category.limit_cents) - usedBig, issues, `${category.name} remaining`);
    const percent = category.limit_cents > 0 ? (used / category.limit_cents) * 100 : usedBig > 0n ? 100 : 0;
    const status: BudgetCategorySummary['status'] = usedBig <= 0n ? 'unused' : usedBig > BigInt(category.limit_cents) ? 'over' : percent >= NEAR_CAP_PERCENT ? 'near' : 'ok';
    return {
      ...category,
      used_cents: used,
      spending_cents: category.kind === 'savings' ? 0 : used,
      savings_contributions_cents: category.kind === 'savings' ? used : 0,
      remaining_cents: remaining,
      percent_used: percent,
      status,
    };
  });

  const allocatedBig = sumBig(categories.map((category) => category.limit_cents));
  const usedBig = spending + savings;
  const subscriptionAverage = monthlySubscriptionAverage(options.subscriptions ?? [], issues);
  const minimums = debtMinimumTotal(options.debts ?? [], issues);
  const withoutAdvice: Omit<BudgetSummary, 'advice'> = {
    month,
    income_cents: income,
    allocated_cents: safeNumber(allocatedBig, issues, 'Allocated total'),
    unassigned_cents: safeNumber(BigInt(income) - allocatedBig, issues, 'Unassigned total'),
    used_cents: safeNumber(usedBig, issues, 'Used total'),
    spending_cents: safeNumber(spending, issues, 'Spending total'),
    savings_contributions_cents: safeNumber(savings, issues, 'Savings contribution total'),
    remaining_income_cents: safeNumber(BigInt(income) - usedBig, issues, 'Remaining income'),
    uncategorized_cents: safeNumber(uncategorized, issues, 'Uncategorized total'),
    uncategorized_count: uncategorizedCount,
    transaction_count: transactionCount,
    subscription_average_cents: subscriptionAverage,
    debt_minimums_cents: minimums,
    category_summaries: categorySummaries,
    issues,
  };
  return { ...withoutAdvice, advice: makeAdvice(withoutAdvice) };
}
