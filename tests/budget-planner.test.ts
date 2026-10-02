import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MONEY_MAX,
  allocate503020,
  dateIsInBudgetMonth,
  summarizeBudgetMonth,
  transactionsForMonth,
  validateBudgetInput,
} from '../src/lib/budget-planner.ts';
import type { BudgetCategory, BudgetMonth, BudgetTransaction, PersonalDebt, Subscription } from '../src/lib/finance-types.ts';

const ids = {
  needs: '11111111-1111-4111-8111-111111111111',
  wants: '22222222-2222-4222-8222-222222222222',
  savings: '33333333-3333-4333-8333-333333333333',
};

const categories: BudgetCategory[] = [
  { id: ids.needs, name: 'Needs', kind: 'needs', limit_cents: 50_000 },
  { id: ids.wants, name: 'Wants', kind: 'wants', limit_cents: 30_000 },
  { id: ids.savings, name: 'Savings', kind: 'savings', limit_cents: 20_000 },
];

const budget: BudgetMonth = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  user_id: 'user',
  month: '2026-09-01',
  income_cents: 100_000,
  categories,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const transaction = (overrides: Partial<BudgetTransaction> = {}): BudgetTransaction => ({
  id: crypto.randomUUID(),
  user_id: 'user',
  description: 'Expense',
  amount_cents: 1_000,
  expense_date: '2026-09-10',
  category_id: ids.needs,
  subscription_id: null,
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
  ...overrides,
});

test('50/30/20 uses exact largest-remainder cent allocation', () => {
  assert.deepEqual(allocate503020(100_00), { needs_cents: 5_000, wants_cents: 3_000, savings_cents: 2_000 });
  assert.deepEqual(allocate503020(10_001), { needs_cents: 5_001, wants_cents: 3_000, savings_cents: 2_000 });
  assert.deepEqual(allocate503020(3), { needs_cents: 1, wants_cents: 1, savings_cents: 1 });
  assert.deepEqual(allocate503020(1), { needs_cents: 1, wants_cents: 0, savings_cents: 0 });
  assert.throws(() => allocate503020(MONEY_MAX + 1), RangeError);
});

test('month filtering uses calendar dates and rejects impossible dates', () => {
  const rows = [
    transaction({ expense_date: '2026-08-31' }),
    transaction({ expense_date: '2026-09-01' }),
    transaction({ expense_date: '2026-09-30' }),
    transaction({ expense_date: '2026-10-01' }),
    transaction({ expense_date: '2026-09-31' }),
  ];
  assert.equal(transactionsForMonth(rows, '2026-09-01').length, 2);
  assert.equal(dateIsInBudgetMonth('2026-02-29', '2026-02-01'), false);
  assert.equal(dateIsInBudgetMonth('2024-02-29', '2024-02-01'), true);
  assert.equal(dateIsInBudgetMonth('0000-01-01', '0000-01-01'), false);
  assert.equal(dateIsInBudgetMonth('2201-01-01', '2201-01-01'), false);
});

test('uncategorized and unknown-category expenses remain counted', () => {
  const summary = summarizeBudgetMonth({
    month: budget.month,
    budget,
    transactions: [
      transaction({ amount_cents: 2_500, category_id: null }),
      transaction({ amount_cents: 1_500, category_id: '99999999-9999-4999-8999-999999999999' }),
      transaction({ amount_cents: 5_000, category_id: ids.needs }),
    ],
  });
  assert.equal(summary.uncategorized_count, 2);
  assert.equal(summary.uncategorized_cents, 4_000);
  assert.equal(summary.spending_cents, 9_000);
  assert.equal(summary.used_cents, 9_000);
  assert.ok(summary.advice.some((item) => item.id === 'uncategorized'));
});

test('savings-kind logs are contributions, not spending', () => {
  const summary = summarizeBudgetMonth({
    month: budget.month,
    budget,
    transactions: [
      transaction({ amount_cents: 8_000, category_id: ids.needs }),
      transaction({ amount_cents: 7_500, category_id: ids.savings }),
    ],
  });
  assert.equal(summary.spending_cents, 8_000);
  assert.equal(summary.savings_contributions_cents, 7_500);
  assert.equal(summary.used_cents, 15_500);
  assert.equal(summary.remaining_income_cents, 84_500);
  const savings = summary.category_summaries.find((row) => row.id === ids.savings)!;
  assert.equal(savings.spending_cents, 0);
  assert.equal(savings.savings_contributions_cents, 7_500);
});

test('subscription averages and debt minimums are reminders only and never double counted', () => {
  const subscriptions: Subscription[] = [{
    id: 'sub', user_id: 'user', name: 'Service', amount_cents: 1_200, cycle: 'monthly', anchor_date: '2026-01-01', status: 'active', notes: '', created_at: '', updated_at: '',
  }];
  const debts: PersonalDebt[] = [{
    id: 'debt', user_id: 'user', name: 'Card', balance_cents: 50_000, apr_bps: 2_000, minimum_cents: 3_000, created_at: '', updated_at: '',
  }];
  const logged = [transaction({ amount_cents: 1_200, subscription_id: 'sub' })];
  const plain = summarizeBudgetMonth({ month: budget.month, budget, transactions: logged });
  const reminded = summarizeBudgetMonth({ month: budget.month, budget, transactions: logged, subscriptions, debts });
  assert.equal(reminded.subscription_average_cents, 1_200);
  assert.equal(reminded.debt_minimums_cents, 3_000);
  assert.equal(reminded.used_cents, plain.used_cents);
  assert.equal(reminded.remaining_income_cents, plain.remaining_income_cents);
  assert.ok(reminded.advice.some((item) => item.id === 'subscriptions'));
  assert.ok(reminded.advice.some((item) => item.id === 'debt-minimums'));
});

test('unsafe per-record values are rejected or ignored without poisoning totals', () => {
  const unsafeBudget = {
    ...budget,
    income_cents: MONEY_MAX + 1,
    categories: [
      ...categories,
      { id: '44444444-4444-4444-8444-444444444444', name: 'Unsafe', kind: 'needs' as const, limit_cents: MONEY_MAX + 1 },
    ],
  };
  const summary = summarizeBudgetMonth({
    month: budget.month,
    budget: unsafeBudget,
    transactions: [
      transaction({ amount_cents: MONEY_MAX + 1 }),
      transaction({ amount_cents: Number.NaN }),
      transaction({ amount_cents: 2_000 }),
    ],
  });
  assert.equal(summary.income_cents, 0);
  assert.equal(summary.used_cents, 2_000);
  assert.ok(Number.isSafeInteger(summary.used_cents));
  assert.ok(summary.issues.length >= 3);

  const errors = validateBudgetInput({
    month: '2026-09-01',
    income_cents: MONEY_MAX + 1,
    categories: [{ id: 'not-a-uuid', name: '', kind: 'needs', limit_cents: 1.5 }],
  });
  assert.ok(errors.length >= 4);
});
