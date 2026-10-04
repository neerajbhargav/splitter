import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BUDGET_LIMITS,
  NEAR_LIMIT_PERCENT,
  addBudgetMonths,
  budgetInsights,
  copyLimits,
  currentBudgetMonth,
  isBudgetMonth,
  lastDateOfMonth,
  monthFromInput,
  starterLimits,
  summarizeBudget,
  transactionsForMonth,
  validateBudgetInput,
} from '../src/lib/budget-planner.ts';
import type { BudgetInsightExtras, BudgetSummary } from '../src/lib/budget-planner.ts';
import { spendingPace } from '../src/lib/finance-insights.ts';
import type {
  BudgetLimit, BudgetMonth, CategoryKind, FinanceCategory, FinanceSettings, FinanceTransaction, TxKind,
} from '../src/lib/finance-types.ts';
import { FINANCE_MAX_CENTS } from '../src/lib/finance-types.ts';

const USER = 'user-1';
const STAMP = '2026-01-01T00:00:00Z';

function cat(id: string, name: string, kind: CategoryKind, sort: number, extra: Partial<FinanceCategory> = {}): FinanceCategory {
  return { id, user_id: USER, name, kind, sort, archived: false, created_at: STAMP, updated_at: STAMP, ...extra };
}
let seq = 0;
function tx(date: string, amount: number, kind: TxKind, category: string | null = null, extra: Partial<FinanceTransaction> = {}): FinanceTransaction {
  seq++;
  return {
    id: `tx-${String(seq).padStart(4, '0')}`, user_id: USER, account_id: null, date, description: `Item ${seq}`,
    amount_cents: amount, kind, category_id: category, subscription_id: null, source: 'manual', external_id: null,
    pending: false, created_at: `${date}T10:00:00Z`, updated_at: `${date}T10:00:00Z`, ...extra,
  };
}
function budget(month: string, income: number, limits: BudgetLimit[]): BudgetMonth {
  return { id: `b-${month}`, user_id: USER, month, income_cents: income, limits, created_at: STAMP, updated_at: STAMP };
}
function settings(net: number): FinanceSettings {
  return { user_id: USER, currency: 'USD', monthly_gross_cents: 0, monthly_net_cents: net, housing_cents: 0, car_cents: 0, categories_seeded: true, pay_cycle: null, pay_anchor: null, pay_day2: null, paycheck_cents: 0, created_at: STAMP, updated_at: STAMP };
}
const fmt = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;

const CATS: FinanceCategory[] = [
  cat('housing', 'Housing', 'needs', 0),
  cat('groceries', 'Groceries', 'needs', 1),
  cat('debt', 'Debt payments', 'needs', 2),
  cat('dining', 'Dining', 'wants', 3),
  cat('subs', 'Subscriptions', 'wants', 4),
  cat('fun', 'Entertainment', 'wants', 5),
  cat('savings', 'Savings', 'savings', 6),
  cat('old', 'Old hobby', 'wants', 7, { archived: true }),
  cat('old2', 'Old club', 'wants', 8, { archived: true }),
];
const MONTH = '2026-09-01';

function summary(over: Partial<Parameters<typeof summarizeBudget>[0]> = {}): BudgetSummary {
  return summarizeBudget({ month: MONTH, today: '2026-09-15', budget: undefined, categories: CATS, transactions: [], settings: null, ...over });
}

/* ---------------------------------------------------------------- months */

test('month helpers validate format, range, leap years and year boundaries', () => {
  assert.equal(isBudgetMonth('2026-10-01'), true);
  assert.equal(isBudgetMonth('2026-10-02'), false);
  assert.equal(isBudgetMonth('2026-13-01'), false);
  assert.equal(isBudgetMonth('1899-12-01'), false);
  assert.equal(isBudgetMonth('1900-01-01'), true);
  assert.equal(isBudgetMonth('2200-12-01'), true);
  assert.equal(isBudgetMonth('2201-01-01'), false);
  assert.equal(monthFromInput('2026-10'), '2026-10-01');
  assert.equal(monthFromInput('2026-10-01'), '2026-10-01');
  assert.equal(monthFromInput('2026-00'), null);
  assert.equal(monthFromInput('garbage'), null);
  assert.equal(addBudgetMonths('2026-12-01', 1), '2027-01-01');
  assert.equal(addBudgetMonths('2026-01-01', -1), '2025-12-01');
  assert.equal(addBudgetMonths('2026-03-01', -14), '2025-01-01');
  assert.equal(addBudgetMonths('2026-03-01', 0), '2026-03-01');
  assert.throws(() => addBudgetMonths('2200-12-01', 1), RangeError);
  assert.throws(() => addBudgetMonths('2026-03-02', 1), RangeError);
  assert.throws(() => addBudgetMonths('2026-03-01', 1.5), RangeError);
  assert.equal(lastDateOfMonth('2024-02-01'), '2024-02-29');
  assert.equal(lastDateOfMonth('2026-02-01'), '2026-02-28');
  assert.equal(lastDateOfMonth('2000-02-01'), '2000-02-29');
  assert.equal(lastDateOfMonth('2100-02-01'), '2100-02-28');
  assert.equal(lastDateOfMonth('2026-12-01'), '2026-12-31');
  assert.equal(lastDateOfMonth('2026-04-01'), '2026-04-30');
  assert.equal(currentBudgetMonth('2024-02-29'), '2024-02-01');
  assert.equal(currentBudgetMonth('2026-12-31'), '2026-12-01');
  assert.throws(() => currentBudgetMonth('2026-02-29'), RangeError);
});

test('transactionsForMonth filters by calendar month and sorts newest first, stable by created_at then id', () => {
  const rows = [
    tx('2026-08-31', 100, 'expense'),
    tx('2026-09-01', 100, 'expense', null, { id: 'a', created_at: '2026-09-01T09:00:00Z' }),
    tx('2026-09-01', 100, 'expense', null, { id: 'b', created_at: '2026-09-01T09:00:00Z' }),
    tx('2026-09-01', 100, 'expense', null, { id: 'c', created_at: '2026-09-01T08:00:00Z' }),
    tx('2026-09-30', 100, 'income'),
    tx('2026-09-31', 100, 'expense'),
    tx('2026-10-01', 100, 'expense'),
  ];
  const got = transactionsForMonth(rows, MONTH);
  assert.deepEqual(got.map((t) => t.date), ['2026-09-30', '2026-09-01', '2026-09-01', '2026-09-01']);
  assert.deepEqual(got.slice(1).map((t) => t.id), ['b', 'a', 'c']);
  assert.deepEqual(transactionsForMonth(rows, '2026-09'), []);
});

/* ---------------------------------------------------------------- summary */

test('planned income comes from the budget, then the profile, then nothing', () => {
  const b = budget(MONTH, 400_000, []);
  assert.deepEqual([summary({ budget: b, settings: settings(500_000) }).planned_income_cents, summary({ budget: b }).income_source], [400_000, 'budget']);
  const zeroIncome = budget(MONTH, 0, [{ category_id: 'housing', limit_cents: 100 }]);
  const s = summary({ budget: zeroIncome, settings: settings(500_000) });
  assert.equal(s.planned_income_cents, 500_000);
  assert.equal(s.income_source, 'profile');
  assert.equal(s.is_set_up, true);
  const none = summary({});
  assert.equal(none.planned_income_cents, 0);
  assert.equal(none.income_source, 'none');
  assert.equal(none.is_set_up, false);
  assert.equal(summary({ budget: budget(MONTH, 0, []) }).is_set_up, false);
  // A budget for another month is ignored.
  assert.equal(summary({ budget: budget('2026-08-01', 400_000, []) }).income_source, 'none');
});

test('money math: transfers excluded, savings separate from spending, uncategorized counted', () => {
  const b = budget(MONTH, 500_000, [
    { category_id: 'housing', limit_cents: 200_000 },
    { category_id: 'dining', limit_cents: 30_000 },
    { category_id: 'savings', limit_cents: 50_000 },
  ]);
  const s = summary({
    budget: b,
    transactions: [
      tx('2026-09-01', 200_000, 'expense', 'housing'),
      tx('2026-09-05', 12_345, 'expense', 'dining'),
      tx('2026-09-06', 50_000, 'expense', 'savings'),
      tx('2026-09-07', 99_999, 'transfer'),
      tx('2026-09-08', 2_500, 'expense', null),
      tx('2026-09-09', 1_500, 'expense', 'deleted-category'),
      tx('2026-09-10', 250_000, 'income'),
      tx('2026-08-31', 77_777, 'expense', 'dining'),
    ],
  });
  assert.equal(s.actual_income_cents, 250_000);
  assert.equal(s.assigned_cents, 280_000);
  assert.equal(s.ready_to_assign_cents, 220_000);
  assert.equal(s.spent_cents, 200_000 + 12_345 + 2_500 + 1_500);
  assert.equal(s.saved_cents, 50_000);
  assert.equal(s.left_cents, 500_000 - s.spent_cents - 50_000);
  assert.equal(s.spending_limit_cents, 230_000);
  assert.equal(s.savings_limit_cents, 50_000);
  assert.equal(s.uncategorized_cents, 4_000);
  assert.equal(s.uncategorized_count, 2);
});

test('rows: limits or activity, archived only with activity, ordered by kind, sort, name', () => {
  const b = budget(MONTH, 500_000, [
    { category_id: 'savings', limit_cents: 10_000 },
    { category_id: 'groceries', limit_cents: 40_000 },
    { category_id: 'old2', limit_cents: 5_000 },
    { category_id: 'ghost', limit_cents: 9_999 },
  ]);
  const s = summary({
    budget: b,
    transactions: [tx('2026-09-02', 1_000, 'expense', 'old'), tx('2026-09-03', 4_200, 'expense', 'dining')],
  });
  assert.deepEqual(s.rows.map((r) => r.category.id), ['groceries', 'dining', 'old', 'savings']);
  const dining = s.rows.find((r) => r.category.id === 'dining')!;
  assert.equal(dining.status, 'unbudgeted');
  assert.equal(dining.limit_cents, null);
  assert.equal(dining.remaining_cents, null);
  assert.equal(dining.percent, null);
  assert.equal(dining.used_cents, 4_200);
  // Archived-without-activity and unknown-category limits do not count as assigned.
  assert.equal(s.assigned_cents, 50_000);

  const sameKind = [cat('z', 'Zed', 'needs', 1), cat('a', 'Ay', 'needs', 1), cat('first', 'Later name', 'needs', 0)];
  const s2 = summarizeBudget({
    month: MONTH, today: '2026-09-15', categories: sameKind, transactions: [], settings: null,
    budget: budget(MONTH, 0, sameKind.map((c) => ({ category_id: c.id, limit_cents: 100 }))),
  });
  assert.deepEqual(s2.rows.map((r) => r.category.id), ['first', 'a', 'z']);
});

test('row statuses: under, near at exactly 85%, over, savings funded never over', () => {
  assert.equal(NEAR_LIMIT_PERCENT, 85);
  const b = budget(MONTH, 500_000, [
    { category_id: 'housing', limit_cents: 10_000 },
    { category_id: 'groceries', limit_cents: 10_000 },
    { category_id: 'debt', limit_cents: 10_000 },
    { category_id: 'dining', limit_cents: 10_000 },
    { category_id: 'fun', limit_cents: 0 },
    { category_id: 'subs', limit_cents: 0 },
    { category_id: 'savings', limit_cents: 10_000 },
  ]);
  const s = summary({
    budget: b,
    transactions: [
      tx('2026-09-02', 8_499, 'expense', 'housing'),
      tx('2026-09-02', 8_500, 'expense', 'groceries'),
      tx('2026-09-02', 10_000, 'expense', 'debt'),
      tx('2026-09-02', 10_001, 'expense', 'dining'),
      tx('2026-09-02', 1, 'expense', 'fun'),
      tx('2026-09-02', 15_000, 'expense', 'savings'),
    ],
  });
  const by = Object.fromEntries(s.rows.map((r) => [r.category.id, r]));
  assert.equal(by.housing.status, 'under');
  assert.equal(by.housing.percent, 84);
  assert.equal(by.groceries.status, 'near');
  assert.equal(by.groceries.percent, 85);
  assert.equal(by.debt.status, 'near');
  assert.equal(by.debt.remaining_cents, 0);
  assert.equal(by.dining.status, 'over');
  assert.equal(by.dining.remaining_cents, -1);
  assert.equal(by.fun.status, 'over');
  assert.equal(by.fun.percent, null);
  assert.equal(by.subs.status, 'under');
  assert.equal(by.savings.status, 'funded');
  assert.equal(by.savings.percent, 150);

  const near = summary({ budget: budget(MONTH, 1, [{ category_id: 'savings', limit_cents: 10_000 }]), transactions: [tx('2026-09-02', 8_500, 'expense', 'savings')] });
  assert.equal(near.rows[0].status, 'near');
});

test('pace uses the spending limit, falling back to income minus savings limits', () => {
  const txs = [tx('2026-09-01', 30_000, 'expense', 'dining'), tx('2026-09-02', 9_000, 'expense', 'savings')];
  const withLimits = summary({ budget: budget(MONTH, 500_000, [{ category_id: 'dining', limit_cents: 60_000 }, { category_id: 'savings', limit_cents: 100_000 }]), transactions: txs });
  assert.equal(withLimits.pace_planned_cents, 60_000);
  assert.deepEqual(withLimits.pace, spendingPace({ month: MONTH, today: '2026-09-15', spentCents: 30_000, plannedCents: 60_000 }));
  const onlySavings = summary({ budget: budget(MONTH, 500_000, [{ category_id: 'savings', limit_cents: 100_000 }]), transactions: txs });
  assert.equal(onlySavings.pace_planned_cents, 400_000);
  const negative = summary({ budget: budget(MONTH, 50_000, [{ category_id: 'savings', limit_cents: 100_000 }]), transactions: txs });
  assert.equal(negative.pace_planned_cents, 0);
  assert.equal(summary({ today: '2026-10-03' }).pace.status, 'past');
  assert.equal(summary({ today: '2026-08-03' }).pace.status, 'future');
  assert.throws(() => summary({ month: '2026-09-15' }), RangeError);
});

/* ---------------------------------------------------------------- insights */

function extras(over: Partial<BudgetInsightExtras> = {}): BudgetInsightExtras {
  return { subscriptionsMonthlyCents: 0, debtMinimumsCents: 0, categories: CATS, format: fmt, ...over };
}
const hasNumber = (s: string) => /\d/.test(s);

test('insights: over-limit first with exact overage, then pace, then near, at most five', () => {
  const b = budget(MONTH, 500_000, [
    { category_id: 'dining', limit_cents: 20_000 },
    { category_id: 'fun', limit_cents: 10_000 },
    { category_id: 'groceries', limit_cents: 50_000 },
    { category_id: 'housing', limit_cents: 100_000 },
    { category_id: 'subs', limit_cents: 1_000 },
    { category_id: 'debt', limit_cents: 5_000 },
  ]);
  const s = summary({
    budget: b,
    transactions: [
      tx('2026-09-03', 24_210, 'expense', 'dining'),
      tx('2026-09-03', 30_000, 'expense', 'fun'),
      tx('2026-09-03', 2_000, 'expense', 'subs'),
      tx('2026-09-03', 45_000, 'expense', 'groceries'),
      tx('2026-09-04', 1_234, 'expense', null),
    ],
  });
  const list = budgetInsights(s, extras({ subscriptionsMonthlyCents: 5_000, debtMinimumsCents: 24_500 }));
  assert.equal(list.length, 5);
  assert.equal(list[0].id, 'over-fun');
  assert.equal(list[0].title, 'Entertainment is $200.00 over');
  assert.equal(list[0].tone, 'bad');
  assert.deepEqual(list[0].action, { kind: 'assign', category_id: 'fun' });
  assert.equal(list[1].id, 'over-dining');
  assert.equal(list[1].title, 'Dining is $42.10 over');
  assert.match(list[1].detail, /1 more category is over too/);
  assert.equal(list[2].id, 'pace');
  assert.equal(list[2].tone, 'warn');
  assert.match(list[2].title, /^At this pace you'll spend \$[\d,.]+ by month end, \$[\d,.]+ over plan$/);
  assert.equal(list[3].id, 'near-groceries');
  assert.equal(list[3].title, 'Groceries is at 90% with 16 days left');
  assert.equal(list[4].id, 'unassigned');
  for (const i of list) {
    assert.ok(hasNumber(i.title + i.detail), i.id);
    assert.ok(!/[\u2014\u2013]/.test(i.title + i.detail), `no dashes in ${i.id}`);
  }
});

test('insights: on-track pace, unassigned, over-assigned, uncategorized, savings funded', () => {
  const b = budget(MONTH, 500_000, [
    { category_id: 'dining', limit_cents: 60_000 },
    { category_id: 'savings', limit_cents: 20_000 },
  ]);
  const s = summary({ budget: b, transactions: [tx('2026-09-03', 10_000, 'expense', 'dining'), tx('2026-09-03', 20_000, 'expense', 'savings'), tx('2026-09-04', 500, 'expense')] });
  const list = budgetInsights(s, extras());
  assert.deepEqual(list.map((i) => i.id), ['pace', 'unassigned', 'uncategorized', 'savings-funded']);
  // 60000 - 10500 = 49500 over 16 days = 3093 per day (floored)
  assert.equal(list[0].title, 'On track: about $30.93 a day left for 16 days');
  assert.equal(list[0].tone, 'good');
  assert.equal(list[1].title, '$4,200.00 isn\'t assigned yet'.replace('$4,200.00', fmt(420_000)));
  assert.equal(list[2].title, '1 expense needs a category');
  assert.deepEqual(list[2].action, { kind: 'categorize' });
  assert.equal(list[3].title, 'Savings target reached');
  assert.equal(list[3].tone, 'good');
  assert.ok(hasNumber(list[3].detail));

  const over = summary({ budget: budget(MONTH, 10_000, [{ category_id: 'housing', limit_cents: 15_000 }]), today: '2026-10-02' });
  const overList = budgetInsights(over, extras());
  assert.deepEqual(overList.map((i) => i.id), ['overassigned']);
  assert.equal(overList[0].title, `You've assigned ${fmt(5_000)} more than you expect to earn`);

  // Past month: no pace insight, near uses wording without days.
  const past = summary({
    today: '2026-10-02',
    budget: budget(MONTH, 0, [{ category_id: 'groceries', limit_cents: 10_000 }]),
    transactions: [tx('2026-09-03', 9_000, 'expense', 'groceries')],
  });
  const pastList = budgetInsights(past, extras());
  assert.deepEqual(pastList.map((i) => i.id), ['near-groceries']);
  assert.equal(pastList[0].title, 'Groceries used 90% of its limit');

  // Empty month without income: nothing to say rather than vague advice.
  assert.deepEqual(budgetInsights(summary({ today: '2026-10-02' }), extras()), []);
});

test('insights: subscriptions and debt only when they exceed their limits', () => {
  const b = budget(MONTH, 0, [{ category_id: 'subs', limit_cents: 3_000 }, { category_id: 'debt', limit_cents: 20_000 }]);
  const s = summary({ budget: b, today: '2026-10-02' });
  const below = budgetInsights(s, extras({ subscriptionsMonthlyCents: 3_000, debtMinimumsCents: 20_000 }));
  assert.deepEqual(below.map((i) => i.id), []);
  const above = budgetInsights(s, extras({ subscriptionsMonthlyCents: 4_599, debtMinimumsCents: 24_500 }));
  assert.deepEqual(above.map((i) => i.id), ['subscriptions', 'debt']);
  assert.equal(above[0].title, `Subscriptions average ${fmt(4_599)} a month, ${fmt(1_599)} over the limit`);
  assert.equal(above[1].title, `Debt minimums need ${fmt(24_500)}, ${fmt(4_500)} more than budgeted`);
  assert.deepEqual(above[1].action, { kind: 'debt', category_id: 'debt' });

  const noLimit = summary({ budget: budget(MONTH, 0, []), today: '2026-10-02' });
  const noLimitList = budgetInsights(noLimit, extras({ subscriptionsMonthlyCents: 9_999, debtMinimumsCents: 6_500 }));
  assert.deepEqual(noLimitList.map((i) => i.id), ['debt']);
  assert.equal(noLimitList[0].title, `Set aside ${fmt(6_500)} for debt minimums`);
  assert.equal(noLimitList[0].tone, 'info');
});

/* ---------------------------------------------------------------- starter / copy / validation */

test('starter limits split 50/30/20 exactly, then evenly within each kind', () => {
  const limits = starterLimits({ incomeCents: 540_001, categories: CATS });
  const by = Object.fromEntries(limits.map((l) => [l.category_id, l.limit_cents]));
  const sum = (ids: string[]) => ids.reduce((a, id) => a + (by[id] ?? 0), 0);
  // wants = floor(30%) = 162000, savings = floor(20%) = 108000, needs gets the rest = 270001
  assert.equal(sum(['housing', 'groceries', 'debt']), 270_001);
  assert.equal(sum(['dining', 'subs', 'fun']), 162_000);
  assert.equal(sum(['savings']), 108_000);
  assert.deepEqual([by.housing, by.groceries, by.debt], [90_001, 90_000, 90_000]);
  assert.equal(by.old, undefined, 'archived categories get nothing');
  assert.equal(limits.reduce((a, l) => a + l.limit_cents, 0), 540_001);

  // Remainder goes to the lowest sort, then id.
  const tie = [cat('b', 'B', 'needs', 0), cat('a', 'A', 'needs', 0), cat('c', 'C', 'needs', -1)];
  assert.deepEqual(starterLimits({ incomeCents: 10, categories: tie }), [
    { category_id: 'c', limit_cents: 2 }, { category_id: 'a', limit_cents: 2 }, { category_id: 'b', limit_cents: 1 },
  ]);

  // Kinds without categories leave their share unassigned.
  const onlyNeeds = starterLimits({ incomeCents: 100_000, categories: [cat('n', 'N', 'needs', 0), cat('s', 'S', 'savings', 1)] });
  assert.deepEqual(onlyNeeds, [{ category_id: 'n', limit_cents: 50_000 }, { category_id: 's', limit_cents: 20_000 }]);
  assert.deepEqual(starterLimits({ incomeCents: 0, categories: [cat('n', 'N', 'needs', 0)] }), [{ category_id: 'n', limit_cents: 0 }]);
  assert.deepEqual(starterLimits({ incomeCents: 5_000, categories: [] }), []);
  assert.throws(() => starterLimits({ incomeCents: -1, categories: CATS }), RangeError);
  assert.throws(() => starterLimits({ incomeCents: 1.5, categories: CATS }), RangeError);
  assert.throws(() => starterLimits({ incomeCents: FINANCE_MAX_CENTS + 1, categories: CATS }), RangeError);
});

test('copyLimits keeps limits for live categories only, without re-IDing', () => {
  assert.deepEqual(copyLimits(undefined, CATS), []);
  const prev = budget('2026-08-01', 1, [
    { category_id: 'housing', limit_cents: 100 },
    { category_id: 'old', limit_cents: 200 },
    { category_id: 'gone', limit_cents: 300 },
    { category_id: 'housing', limit_cents: 999 },
    { category_id: 'dining', limit_cents: 400 },
  ]);
  const copied = copyLimits(prev, CATS);
  assert.deepEqual(copied, [{ category_id: 'housing', limit_cents: 100 }, { category_id: 'dining', limit_cents: 400 }]);
  copied[0].limit_cents = 1;
  assert.equal(prev.limits[0].limit_cents, 100, 'returns copies');
});

test('validateBudgetInput catches bad months, unsafe money, duplicate and unknown categories, too many limits', () => {
  assert.deepEqual(validateBudgetInput({ month: MONTH, income_cents: 500_000, limits: [{ category_id: 'housing', limit_cents: 0 }] }, CATS), []);
  const errors = validateBudgetInput({
    month: '2026-09-15',
    income_cents: FINANCE_MAX_CENTS + 1,
    limits: [
      { category_id: 'housing', limit_cents: 1.5 },
      { category_id: 'housing', limit_cents: 100 },
      { category_id: 'nope', limit_cents: -1 },
    ],
  }, CATS);
  assert.equal(errors.length, 6);
  assert.ok(errors.some((e) => /month/.test(e)));
  assert.ok(errors.some((e) => /repeats/.test(e)));
  assert.ok(errors.some((e) => /doesn't exist/.test(e)));
  assert.ok(errors.every((e) => !/[\u2014]/.test(e)));
  const many = Array.from({ length: MAX_BUDGET_LIMITS + 1 }, (_, i) => cat(`c${i}`, `C${i}`, 'needs', i));
  const tooMany = validateBudgetInput({ month: MONTH, income_cents: 0, limits: many.map((c) => ({ category_id: c.id, limit_cents: 1 })) }, many);
  assert.deepEqual(tooMany, [`A month can have at most ${MAX_BUDGET_LIMITS} limits.`]);
  assert.ok(validateBudgetInput({ month: MONTH, income_cents: Number.NaN, limits: [] }, CATS).length === 1);
});

test('insights: early-month overspend shows daily room instead of a wild projection; exactly-at-limit is quiet', () => {
  const b = budget(MONTH, 500_000, [{ category_id: 'housing', limit_cents: 200_000 }, { category_id: 'dining', limit_cents: 100_000 }]);
  const txs = [tx('2026-09-01', 200_000, 'expense', 'housing')];
  const early = budgetInsights(summary({ budget: b, transactions: txs, today: '2026-09-03' }), extras());
  assert.equal(early[0].id, 'pace');
  assert.equal(early[0].tone, 'info');
  // (300000 - 200000) / 28 days = 3571
  assert.equal(early[0].title, 'About $35.71 a day left for 28 days');
  assert.ok(!early.some((i) => i.id === 'near-housing'));
  const later = budgetInsights(summary({ budget: b, transactions: txs, today: '2026-09-07' }), extras());
  assert.equal(later[0].tone, 'warn');
  assert.match(later[0].title, /^At this pace/);
});

/* ---------------------------------------------------------------- flexible pace */

test('flexible pace ignores rent landing early', () => {
  const b = budget(MONTH, 500_000, [
    { category_id: 'housing', limit_cents: 150_000 }, { category_id: 'dining', limit_cents: 30_000 }, { category_id: 'subs', limit_cents: 2_000 },
  ]);
  const txs = [
    tx('2026-09-01', 150_000, 'expense', 'housing'), tx('2026-09-10', 6_000, 'expense', 'dining'), tx('2026-09-02', 1_500, 'expense', 'subs'),
  ];
  const s = summary({ budget: b, transactions: txs });
  assert.equal(s.flexible?.planned_cents, 30_000);
  assert.equal(s.flexible?.spent_cents, 6_000);
  assert.deepEqual(s.flexible?.category_ids, ['dining']);
  assert.equal(s.flexible?.pace.safePerDayCents, 1_500);
  assert.equal(s.flexible?.pace.status, 'under');
  const pace = budgetInsights(s, extras({ paceBasis: 'flexible' })).find((i) => i.id === 'pace');
  assert.equal(pace?.tone, 'good');
  assert.equal(pace?.title, 'On track: about $15.00 a day left for wants');
  assert.equal(pace?.detail, '$60.00 of your $300.00 wants plan spent, 16 days to go.');
  const legacy = budgetInsights(s, extras()).find((i) => i.id === 'pace');
  assert.match(legacy?.title ?? '', /^At this pace/);
});

test('flexible is null without positive wants limits', () => {
  const b = budget(MONTH, 500_000, [{ category_id: 'housing', limit_cents: 100_000 }, { category_id: 'fun', limit_cents: 0 }]);
  const s = summary({ budget: b });
  assert.equal(s.flexible, null);
  assert.equal(budgetInsights(s, extras({ paceBasis: 'flexible' })).some((i) => i.id === 'pace'), false);
});

test('flexible over pace waits for day 7', () => {
  const b = budget(MONTH, 500_000, [{ category_id: 'dining', limit_cents: 30_000 }]);
  const txs = [tx('2026-09-01', 20_000, 'expense', 'dining')];
  const early = budgetInsights(summary({ budget: b, transactions: txs, today: '2026-09-03' }), extras({ paceBasis: 'flexible' })).find((i) => i.id === 'pace');
  assert.ok(early);
  assert.doesNotMatch(early.title, /on pace for/);
  assert.match(early.title, /^About \$/);
  const late = budgetInsights(summary({ budget: b, transactions: txs, today: '2026-09-15' }), extras({ paceBasis: 'flexible' })).find((i) => i.id === 'pace');
  assert.equal(late?.title, 'Wants are on pace for $400.00, $100.00 over plan');
});

test('flexible plan used up', () => {
  const b = budget(MONTH, 500_000, [{ category_id: 'dining', limit_cents: 10_000 }]);
  const s = summary({ budget: b, transactions: [tx('2026-09-05', 12_000, 'expense', 'dining')], today: '2026-09-15' });
  const pace = budgetInsights(s, extras({ paceBasis: 'flexible' })).find((i) => i.id === 'pace');
  assert.equal(pace?.tone, 'warn');
  assert.equal(pace?.detail, '$120.00 spent against a $100.00 wants plan, 16 days to go.');
});

test('flexible past month has no pace insight', () => {
  const b = budget(MONTH, 500_000, [{ category_id: 'dining', limit_cents: 30_000 }]);
  const s = summary({ budget: b, today: '2026-10-03' });
  assert.equal(s.flexible?.pace.status, 'past');
  assert.equal(budgetInsights(s, extras({ paceBasis: 'flexible' })).some((i) => i.id === 'pace'), false);
});

test('flexible excludes archived wants categories with a limit', () => {
  const b = budget(MONTH, 500_000, [{ category_id: 'dining', limit_cents: 30_000 }, { category_id: 'old', limit_cents: 5_000 }]);
  const s = summary({ budget: b, transactions: [tx('2026-09-04', 1_000, 'expense', 'old')] });
  assert.deepEqual(s.flexible?.category_ids, ['dining']);
});
