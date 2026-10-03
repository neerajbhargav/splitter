import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoBundle } from '../src/lib/finance-demo.ts';
import { budgetInsights, summarizeBudget } from '../src/lib/budget-planner.ts';
import { buildAiContext, evaluateHealth, monthActivity, monthKey, netWorth } from '../src/lib/finance-insights.ts';
import { forecastSubscriptionCharges, isValidCalendarDate, subscriptionEquivalentTotals } from '../src/lib/subscription-planner.ts';
import { DEFAULT_CATEGORIES } from '../src/lib/finance-types.ts';

const DAYS = ['2026-10-17', '2026-10-01', '2024-02-29', '2027-01-31', '2026-03-31', '2025-12-02'];
const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;

test('deterministic for the same today and different for a different today', () => {
  assert.deepEqual(demoBundle('2026-10-17'), demoBundle('2026-10-17'));
  assert.notDeepEqual(demoBundle('2026-10-17').transactions, demoBundle('2026-10-18').transactions);
  const other = demoBundle('2026-10-17', 'someone');
  assert.equal(other.user_id, 'someone');
  assert.ok(other.transactions.every((t) => t.user_id === 'someone'));
  assert.ok(other.accounts.every((a) => a.user_id === 'someone'));
  assert.throws(() => demoBundle('2026-02-30'), RangeError);
  assert.throws(() => demoBundle('soon'), RangeError);
});

for (const today of DAYS) {
  test(`integrity for ${today}`, () => {
    const b = demoBundle(today);
    const month = monthKey(today);

    // Settings and categories.
    assert.equal(b.settings?.currency, 'USD');
    assert.deepEqual(
      [b.settings?.monthly_gross_cents, b.settings?.monthly_net_cents, b.settings?.housing_cents, b.settings?.car_cents],
      [750_000, 540_000, 185_000, 0],
    );
    assert.deepEqual(b.categories.map((c) => [c.name, c.kind]), DEFAULT_CATEGORIES.map((c) => [c.name, c.kind]));
    assert.ok(b.categories.some((c) => c.id === 'demo-cat-groceries'));
    assert.deepEqual(b.connections, []);

    // Unique ids across every collection.
    const all = [...b.accounts, ...b.holdings, ...b.categories, ...b.budgets, ...b.transactions, ...b.subscriptions].map((r) => r.id);
    assert.equal(new Set(all).size, all.length);

    // Accounts: fake last4, expected shapes.
    for (const a of b.accounts) assert.match(a.last4 ?? '', /^0(\d)0\1$/);
    const types = b.accounts.map((a) => a.type).sort();
    assert.deepEqual(types, ['checking', 'credit', 'investment', 'loan', 'savings']);
    const card = b.accounts.find((a) => a.type === 'credit')!;
    assert.deepEqual([card.apr_bps, card.minimum_cents, card.in_payoff], [2_499, 6_500, true]);
    const loan = b.accounts.find((a) => a.type === 'loan')!;
    assert.deepEqual([loan.apr_bps, loan.minimum_cents], [550, 18_000]);
    assert.deepEqual(b.holdings.map((h) => h.symbol), ['VTI', 'VXUS', 'BND']);
    const accountIds = new Set(b.accounts.map((a) => a.id));
    assert.ok(b.holdings.every((h) => accountIds.has(h.account_id)));

    // Subscriptions: 6 active (incl. weekly + yearly), 1 paused, 1 canceled, several renewing soon.
    const subs = b.subscriptions;
    assert.equal(subs.filter((s) => s.status === 'active').length, 6);
    assert.equal(subs.filter((s) => s.status === 'paused').length, 1);
    assert.equal(subs.filter((s) => s.status === 'canceled').length, 1);
    assert.ok(subs.some((s) => s.status === 'active' && s.cycle === 'weekly'));
    assert.ok(subs.some((s) => s.status === 'active' && s.cycle === 'yearly'));
    assert.ok(subs.every((s) => isValidCalendarDate(s.anchor_date) && s.anchor_date <= today));
    const soon = new Set(forecastSubscriptionCharges(subs, today, 30).map((c) => c.subscription_id));
    assert.ok(soon.size >= 4, `only ${soon.size} renew in 30 days`);

    // Budgets: current + two previous months, limits within take-home and pointing at real categories.
    const catIds = new Set(b.categories.map((c) => c.id));
    assert.equal(b.budgets.length, 3);
    assert.equal(b.budgets[2].month, month);
    for (const budget of b.budgets) {
      const total = budget.limits.reduce((sum, l) => sum + l.limit_cents, 0);
      assert.ok(total <= 540_000, `${budget.month} limits ${total}`);
      assert.ok(budget.limits.every((l) => catIds.has(l.category_id) && Number.isSafeInteger(l.limit_cents) && l.limit_cents >= 0));
    }

    // Ledger references and dates.
    const subIds = new Set(subs.map((s) => s.id));
    const linked = new Set<string>();
    const start = b.budgets[0].month;
    for (const t of b.transactions) {
      assert.ok(isValidCalendarDate(t.date) && t.date <= today && t.date >= start, t.date);
      assert.ok(Number.isSafeInteger(t.amount_cents) && t.amount_cents > 0);
      assert.ok(t.account_id === null || accountIds.has(t.account_id));
      assert.ok(t.category_id === null || catIds.has(t.category_id));
      if (t.kind !== 'expense') assert.equal(t.category_id, null);
      assert.ok(t.created_at.startsWith(t.date) && t.updated_at.startsWith(t.date));
      if (t.subscription_id !== null) {
        assert.ok(subIds.has(t.subscription_id));
        const key = `${t.subscription_id}|${t.date}`;
        assert.ok(!linked.has(key), `duplicate charge ${key}`);
        linked.add(key);
        assert.equal(t.amount_cents, subs.find((s) => s.id === t.subscription_id)!.amount_cents);
      }
    }
    assert.ok(b.transactions.some((t) => t.date === today));
    assert.ok(b.transactions.some((t) => t.kind === 'transfer'));
    assert.ok(b.transactions.some((t) => t.kind === 'expense' && t.category_id === null));
    assert.ok(b.transactions.some((t) => t.kind === 'income'));
    // Paused subscriptions never charge.
    const paused = subs.find((s) => s.status === 'paused')!;
    assert.ok(!b.transactions.some((t) => t.subscription_id === paused.id));
    // Rent on the 1st of every month.
    for (const bm of b.budgets) assert.ok(b.transactions.some((t) => t.date === bm.month && t.amount_cents === 185_000 && t.category_id === 'demo-cat-housing'));

    // Insight functions run, and Dining is a little over this month.
    const summary = summarizeBudget({ month, today, budget: b.budgets[2], categories: b.categories, transactions: b.transactions, settings: b.settings });
    const dining = summary.rows.find((r) => r.category.name === 'Dining')!;
    assert.equal(dining.status, 'over');
    const overBy = dining.used_cents - (dining.limit_cents ?? 0);
    assert.ok(overBy > 0 && overBy <= 5_000, `dining over by ${overBy}`);
    assert.equal(summary.income_source, 'budget');
    const insights = budgetInsights(summary, {
      subscriptionsMonthlyCents: Number(subscriptionEquivalentTotals(subs).monthly_cents),
      debtMinimumsCents: 24_500,
      categories: b.categories,
      format: fmt,
    });
    assert.equal(insights[0].id, 'over-demo-cat-dining');
    const worth = netWorth(b.accounts, b.holdings);
    assert.ok(worth.assets > 0 && worth.liabilities > 0);
    assert.ok(Number.isSafeInteger(worth.net));
    assert.equal(evaluateHealth({ ...b, settings: b.settings, today, currency: 'USD' }).length, 6);
    assert.ok(buildAiContext(b, today).length > 0);
    assert.ok(monthActivity(b.transactions, b.categories, month).income > 0 || Number(today.slice(8, 10)) < 14);
  });
}

test('amounts look real: most non-fixed expenses are not whole dollars', () => {
  const b = demoBundle('2026-10-17');
  const variable = b.transactions.filter((t) => t.kind === 'expense' && t.source === 'manual' && !/Rent|Transfer to|auto-invest|loan payment/.test(t.description));
  const whole = variable.filter((t) => t.amount_cents % 100 === 0).length;
  assert.ok(whole / variable.length < 0.1, `${whole} of ${variable.length} are whole dollars`);
});
