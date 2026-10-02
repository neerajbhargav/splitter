import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addCalendarMonths,
  compareDebtPlans,
  monthlyInterestCents,
  simulateDebtPlan,
  type DebtPlannerDebt,
} from "../src/lib/debt-planner.ts";

const debt = (overrides: Partial<DebtPlannerDebt> = {}): DebtPlannerDebt => ({
  id: "a",
  name: "Card A",
  balance_cents: 10_000,
  apr_bps: 0,
  minimum_cents: 1_000,
  ...overrides,
});

function plan(debts: DebtPlannerDebt[], extra_monthly_cents = 0, strategy: "avalanche" | "snowball" = "avalanche", first_payment_month = "2026-01") {
  return simulateDebtPlan({ debts, extra_monthly_cents, strategy, first_payment_month });
}

test("monthly nominal APR uses exact bigint cents and half-up rounding", () => {
  assert.equal(monthlyInterestCents(10_000n, 1_200), 100n);
  assert.equal(monthlyInterestCents(5n, 12_000), 1n);
  assert.equal(monthlyInterestCents(4n, 12_000), 0n);
  assert.equal(monthlyInterestCents(999_999_999_999_999_999n, 0), 0n);
});

test("every month and the whole plan conserve cents exactly", () => {
  const result = plan([
    debt({ id: "a", balance_cents: 12_345, apr_bps: 1_999, minimum_cents: 777 }),
    debt({ id: "b", name: "Card B", balance_cents: 54_321, apr_bps: 875, minimum_cents: 1_234 }),
  ], 2_345);
  assert.equal(result.status, "paid_off");
  let paid = 0n;
  for (const month of result.timeline) {
    assert.equal(month.opening_balance_cents + month.interest_cents - month.payment_cents, month.ending_balance_cents);
    assert.equal(month.payments.reduce((sum, row) => sum + row.interest_cents, 0n), month.interest_cents);
    assert.equal(month.payments.reduce((sum, row) => sum + row.payment_cents, 0n), month.payment_cents);
    assert.equal(month.payments.reduce((sum, row) => sum + row.ending_balance_cents, 0n), month.ending_balance_cents);
    paid += month.payment_cents;
  }
  assert.equal(result.total_balance_cents + result.estimated_interest_cents - paid, 0n);
});

test("minimums over the remaining balance are capped and the final payment can be small", () => {
  const result = plan([debt({ balance_cents: 1_001, minimum_cents: 500 })]);
  assert.equal(result.months, 3);
  assert.deepEqual(result.timeline.map((month) => month.payment_cents), [500n, 500n, 1n]);
  assert.equal(result.timeline[2].ending_balance_cents, 0n);

  const overMinimum = plan([debt({ balance_cents: 125, minimum_cents: 500 })]);
  assert.equal(overMinimum.timeline[0].payment_cents, 125n);
  assert.equal(overMinimum.months, 1);
});

test("freed minimums and unused final amounts roll to the target within a constant budget", () => {
  const result = plan([
    debt({ id: "small", balance_cents: 150, minimum_cents: 100 }),
    debt({ id: "large", balance_cents: 1_000, minimum_cents: 100 }),
  ], 100, "snowball");
  assert.equal(result.monthly_commitment_cents, 300n);
  assert.equal(result.timeline[0].payment_cents, 300n);
  assert.equal(result.timeline[0].payments.find((row) => row.debt_id === "small")?.payment_cents, 150n);
  assert.equal(result.timeline[0].payments.find((row) => row.debt_id === "large")?.payment_cents, 150n);
});

test("avalanche and snowball choose different targets and ties are deterministic", () => {
  const debts = [
    debt({ id: "high", balance_cents: 10_000, apr_bps: 1_200, minimum_cents: 100 }),
    debt({ id: "small", balance_cents: 5_000, apr_bps: 0, minimum_cents: 100 }),
  ];
  const avalanche = plan(debts, 5_000, "avalanche");
  const snowball = plan(debts, 5_000, "snowball");
  assert.equal(avalanche.timeline[0].payments.find((row) => row.debt_id === "high")?.payment_cents, 5_100n);
  assert.equal(snowball.payoff_order[0].debt_id, "small");

  const tied = plan([
    debt({ id: "first", name: "First", balance_cents: 500, minimum_cents: 100 }),
    debt({ id: "second", name: "Second", balance_cents: 500, minimum_cents: 100 }),
  ], 400, "snowball");
  assert.equal(tied.payoff_order[0].debt_id, "first");
});

test("zero APR is valid and payment months advance without timezone rollover", () => {
  const result = plan([debt({ balance_cents: 1_001, minimum_cents: 500, apr_bps: 0 })], 0, "avalanche", "2026-11");
  assert.equal(result.estimated_interest_cents, 0n);
  assert.deepEqual(result.timeline.map((month) => month.month), ["2026-11", "2026-12", "2027-01"]);
  assert.equal(result.payoff_month, "2027-01");
  assert.equal(addCalendarMonths("2024-02", 12), "2025-02");
  assert.throws(() => addCalendarMonths("2026-13", 0), /calendar range/);
  assert.throws(() => plan([debt()], 0, "avalanche", "2026-1"), /YYYY-MM/);
});

test("negative amortization and a slow finite-direction plan have separate statuses", () => {
  const growing = plan([debt({ balance_cents: 10_000, apr_bps: 1_200, minimum_cents: 1 })]);
  assert.equal(growing.status, "negative_amortization");
  assert.equal(growing.is_finite, false);
  assert.equal(growing.months, null);
  assert.equal(growing.timeline.length, 600);
  assert.ok(growing.ending_balance_cents > growing.total_balance_cents);

  const slow = plan([debt({ balance_cents: 100_000, apr_bps: 0, minimum_cents: 100 })]);
  assert.equal(slow.status, "month_limit");
  assert.equal(slow.is_finite, false);
  assert.equal(slow.timeline.length, 600);
  assert.equal(slow.ending_balance_cents, 40_000n);
});

test("baseline savings are only reported when both plans pay off within 600 months", () => {
  const finite = compareDebtPlans({
    debts: [debt({ balance_cents: 20_000, apr_bps: 2_400, minimum_cents: 1_000 })],
    extra_monthly_cents: 1_000,
    strategy: "avalanche",
    first_payment_month: "2026-01",
  });
  assert.equal(finite.plan.is_finite, true);
  assert.equal(finite.baseline.is_finite, true);
  assert.ok((finite.interest_saved_cents ?? 0n) > 0n);
  assert.ok((finite.months_saved ?? 0) > 0);

  const nonfiniteBaseline = compareDebtPlans({
    debts: [debt({ balance_cents: 10_000, apr_bps: 100_000, minimum_cents: 1 })],
    extra_monthly_cents: 20_000,
    strategy: "avalanche",
    first_payment_month: "2026-01",
  });
  assert.equal(nonfiniteBaseline.plan.is_finite, true);
  assert.equal(nonfiniteBaseline.baseline.is_finite, false);
  assert.equal(nonfiniteBaseline.interest_saved_cents, null);
  assert.equal(nonfiniteBaseline.months_saved, null);
});

test("rejects unsafe, negative, zero-minimum, over-limit, duplicate, and invalid APR inputs", () => {
  assert.throws(() => plan([debt({ minimum_cents: 0 })]), /minimum/);
  assert.throws(() => plan([debt({ balance_cents: -1 })]), /balance/);
  assert.throws(() => plan([debt({ balance_cents: 1_000_000_000_001 })]), /balance/);
  assert.throws(() => plan([debt({ apr_bps: 100_001 })]), /APR/);
  assert.throws(() => plan([debt(), debt({ name: "Duplicate" })]), /unique id/);
  assert.throws(() => plan([debt()], Number.NaN), /Extra monthly/);
  assert.throws(() => plan([debt()], Number.MAX_SAFE_INTEGER), /Extra monthly/);
});
