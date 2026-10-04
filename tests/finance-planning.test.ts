import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateDebtPlan, type DebtPlannerDebt } from "../src/lib/debt-planner.ts";
import {
  addDays, dueDatesInPeriod, mergeSuggestions, nextPaydayAfter, paycheckTotals, paydaysFrom, payPeriod, perPaycheckCents,
  scheduleFromSettings, suggestAllocations,
} from "../src/lib/paycheck-planner.ts";
import { creditOverview, scoreBand, scoreSeries, summarizeBureaus, validateScore } from "../src/lib/credit-scores.ts";
import { payoffDebts, planPaymentLookup, plannerInput } from "../src/lib/finance-selectors.ts";
import { demoBundle } from "../src/lib/finance-demo.ts";
import type { CreditScore, FinanceCategory, Subscription } from "../src/lib/finance-types.ts";

const CARD: DebtPlannerDebt = { id: "card", name: "Card", balance_cents: 100_000, apr_bps: 2_400, minimum_cents: 5_000 };
const LOAN: DebtPlannerDebt = { id: "loan", name: "Loan", balance_cents: 50_000, apr_bps: 600, minimum_cents: 5_000 };
const total = (plan: ReturnType<typeof simulateDebtPlan>, id: string) => plan.timeline.reduce((s, m) => s + (m.payments.find((p) => p.debt_id === id)?.payment_cents ?? 0n), 0n);

/* ---------- custom debt plans ---------- */

test("custom order sends extra money to the debt you choose", () => {
  const avalanche = simulateDebtPlan({ debts: [CARD, LOAN], strategy: "avalanche", extra_monthly_cents: 10_000, first_payment_month: "2030-01" });
  const custom = simulateDebtPlan({ debts: [CARD, LOAN], strategy: "custom", priority: ["loan", "card"], extra_monthly_cents: 10_000, first_payment_month: "2030-01" });
  assert.equal(avalanche.payoff_order[0].debt_id, "card");
  assert.equal(custom.payoff_order[0].debt_id, "loan");
  assert.equal(custom.timeline[0].payments.find((p) => p.debt_id === "loan")!.payment_cents, 15_000n, "minimum plus all the extra");
  assert.ok(custom.estimated_interest_cents > avalanche.estimated_interest_cents, "paying the low-APR debt first costs more interest");
});

test("your own monthly payment replaces the minimum, never goes under it", () => {
  const plan = simulateDebtPlan({ debts: [CARD, LOAN], strategy: "custom", payments: { card: 20_000, loan: 100 }, extra_monthly_cents: 0, first_payment_month: "2030-01" });
  const first = plan.timeline[0];
  assert.equal(first.payments.find((p) => p.debt_id === "card")!.payment_cents, 20_000n);
  assert.equal(first.payments.find((p) => p.debt_id === "loan")!.payment_cents, 5_000n, "below-minimum amounts are raised");
  assert.equal(plan.monthly_commitment_cents, 25_000n);
});

test("rollover off keeps paying only each debt's own amount", () => {
  const on = simulateDebtPlan({ debts: [CARD, LOAN], strategy: "custom", priority: ["loan", "card"], extra_monthly_cents: 0, rollover: true, first_payment_month: "2030-01" });
  const off = simulateDebtPlan({ debts: [CARD, LOAN], strategy: "custom", priority: ["loan", "card"], extra_monthly_cents: 0, rollover: false, first_payment_month: "2030-01" });
  assert.equal(on.is_finite && off.is_finite, true);
  assert.ok(off.months! > on.months!, "without rollover the card takes longer");
  const afterLoan = off.timeline[off.payoff_order[0].payoff_month_number]; // month after the loan is gone
  assert.equal(afterLoan.payment_cents, 5_000n);
  // Every cent paid equals balances plus interest, both ways.
  for (const p of [on, off]) assert.equal(total(p, "card") + total(p, "loan"), 150_000n + p.estimated_interest_cents);
});

test("scheduled extra changes and one-time payments are applied in their month", () => {
  const plan = simulateDebtPlan({
    debts: [CARD, LOAN], strategy: "avalanche", extra_monthly_cents: 0, first_payment_month: "2030-01",
    extra_changes: [{ month: "2030-03", extra_monthly_cents: 20_000 }],
    lump_sums: [{ month: "2030-02", debt_id: "loan", amount_cents: 10_000 }, { month: "2030-02", debt_id: null, amount_cents: 3_000 }],
  });
  assert.equal(plan.timeline[0].payment_cents, 10_000n);
  const feb = plan.timeline[1];
  assert.equal(feb.payment_cents, 23_000n, "minimums plus both lump sums");
  assert.equal(feb.payments.find((p) => p.debt_id === "loan")!.payment_cents, 15_000n, "targeted lump sum goes to the loan");
  assert.equal(feb.payments.find((p) => p.debt_id === "card")!.payment_cents, 8_000n, "untargeted lump sum follows the order");
  assert.equal(plan.timeline[2].payment_cents, 30_000n, "extra starts in March");
  const sum = total(plan, "card") + total(plan, "loan");
  assert.equal(sum, 150_000n + plan.estimated_interest_cents);
});

test("a lump sum bigger than its debt spills into the next one", () => {
  const plan = simulateDebtPlan({ debts: [CARD, LOAN], strategy: "custom", priority: ["card", "loan"], extra_monthly_cents: 0, first_payment_month: "2030-01", lump_sums: [{ month: "2030-01", debt_id: "loan", amount_cents: 200_000 }] });
  assert.equal(plan.timeline[0].ending_balance_cents, 0n);
  assert.equal(plan.months, 1);
});

test("plannerInput only applies custom fields to the custom strategy and drops stale ids", () => {
  const saved = {
    extra_monthly_cents: 1_000, rollover: false, priority: ["gone", "loan"],
    payments: [{ account_id: "card", monthly_cents: 9_000, due_day: 3 }, { account_id: "gone", monthly_cents: 1, due_day: null }],
    extra_changes: [{ month: "2029-12", extra_monthly_cents: 5 }, { month: "2030-04", extra_monthly_cents: 7 }],
    lump_sums: [{ id: "x", month: "2029-01", account_id: "card", amount_cents: 1, note: "" }, { id: "y", month: "2030-02", account_id: "gone", amount_cents: 9, note: "" }],
  };
  const custom = plannerInput([CARD, LOAN], saved, "custom", "2030-01");
  assert.deepEqual(custom.priority, ["loan"]);
  assert.deepEqual(custom.payments, { card: 9_000 });
  assert.equal(custom.rollover, false);
  assert.deepEqual(custom.extra_changes, [{ month: "2030-04", extra_monthly_cents: 7 }]);
  assert.deepEqual(custom.lump_sums, [{ month: "2030-02", debt_id: null, amount_cents: 9 }], "past lump sums dropped, deleted targets fall back to the order");
  const avalanche = plannerInput([CARD, LOAN], saved, "avalanche", "2030-01", 0);
  assert.equal(avalanche.payments, undefined);
  assert.equal(avalanche.extra_monthly_cents, 0);
  const lookup = planPaymentLookup(simulateDebtPlan(custom));
  assert.equal(lookup("card", "2030-01"), 9_000);
  assert.equal(lookup("card", "2029-06"), 9_000, "months before the plan use its first month");
  assert.equal(lookup("card", "2099-01"), 0);
});

/* ---------- pay schedule ---------- */

test("paydays for each schedule", () => {
  assert.deepEqual(paydaysFrom({ cycle: "biweekly", anchor: "2026-08-27", day2: null }, "2026-10-01", 3), ["2026-10-08", "2026-10-22", "2026-11-05"]);
  assert.deepEqual(paydaysFrom({ cycle: "biweekly", anchor: "2026-12-31", day2: null }, "2026-10-08", 1), ["2026-10-08"], "anchor in the future works backwards");
  assert.deepEqual(paydaysFrom({ cycle: "weekly", anchor: "2026-10-02", day2: null }, "2026-10-02", 2), ["2026-10-02", "2026-10-09"]);
  assert.deepEqual(paydaysFrom({ cycle: "monthly", anchor: "2026-01-31", day2: null }, "2026-02-01", 3), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(paydaysFrom({ cycle: "semimonthly", anchor: "2026-01-15", day2: 31 }, "2026-02-10", 4), ["2026-02-15", "2026-02-28", "2026-03-15", "2026-03-31"]);
  assert.deepEqual(paydaysFrom({ cycle: "semimonthly", anchor: "2026-01-30", day2: 31 }, "2026-02-01", 2), ["2026-02-28", "2026-03-30"], "same clamped day counts once");
  assert.equal(nextPaydayAfter({ cycle: "biweekly", anchor: "2026-10-08", day2: null }, "2026-10-08"), "2026-10-22");
  assert.deepEqual(payPeriod("2026-10-08", { cycle: "biweekly", anchor: "2026-10-08", day2: null }), { start: "2026-10-08", end: "2026-10-22", last: "2026-10-21", days: 14 });
  assert.deepEqual(payPeriod("2026-10-08", null).end, "2026-10-22", "no schedule assumes two weeks");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(scheduleFromSettings({ pay_cycle: "semimonthly", pay_anchor: "2026-01-15", pay_day2: null }), null);
  assert.equal(scheduleFromSettings(null), null);
});

test("monthly amounts split per paycheck exactly", () => {
  assert.equal(perPaycheckCents(100_000, "monthly"), 100_000);
  assert.equal(perPaycheckCents(100_001, "semimonthly"), 50_001, "half a cent rounds up");
  assert.equal(perPaycheckCents(540_000, "biweekly"), 249_231);
  assert.equal(perPaycheckCents(100, "weekly"), 23);
  assert.throws(() => perPaycheckCents(1.5, "weekly"), RangeError);
  assert.deepEqual(dueDatesInPeriod(31, { start: "2026-02-20", end: "2026-03-06" }), ["2026-02-28"]);
  assert.deepEqual(dueDatesInPeriod(5, { start: "2026-12-30", end: "2027-01-13" }), ["2027-01-05"]);
});

const cat = (id: string, name: string, kind: FinanceCategory["kind"], sort = 0): FinanceCategory => ({ id, user_id: "u", name, kind, sort, archived: false, created_at: "", updated_at: "" });
const sub = (id: string, name: string, amount: number, anchor: string, extra: Partial<Subscription> = {}): Subscription => ({
  id, user_id: "u", name, amount_cents: amount, cycle: "monthly", anchor_date: anchor, status: "active", notes: "", category_id: null, account_id: null, created_at: "", updated_at: "", ...extra,
});

test("suggestions cover bills and debts due this period plus this paycheck's share of the budget", () => {
  const categories = [cat("rent", "Housing", "needs", 0), cat("food", "Groceries", "needs", 1), cat("fun", "Dining", "wants", 2), cat("subs", "Subscriptions", "wants", 3), cat("debt", "Debt payments", "needs", 4), cat("save", "Savings", "savings", 5)];
  const lines = suggestAllocations({
    period: { start: "2026-10-08", end: "2026-10-22", last: "2026-10-21" },
    cycle: "biweekly",
    subscriptions: [
      sub("music", "Music", 1_199, "2026-01-14", { category_id: "subs" }),
      sub("cloud", "Cloud", 999, "2026-01-28", { category_id: "subs" }),
      sub("old", "Old gym", 4_000, "2026-01-10", { status: "canceled" }),
    ],
    debts: [{ id: "card", name: "Card", due_day: 12 }, { id: "loan", name: "Loan", due_day: 25 }, { id: "car", name: "Car", due_day: null }],
    debtPaymentFor: (id) => ({ card: 25_000, loan: 18_000, car: 30_000 } as Record<string, number>)[id],
    categories,
    limits: [
      { category_id: "rent", limit_cents: 185_000 }, { category_id: "food", limit_cents: 52_000 }, { category_id: "fun", limit_cents: 26_000 },
      { category_id: "subs", limit_cents: 6_000 }, { category_id: "debt", limit_cents: 30_000 }, { category_id: "save", limit_cents: 60_000 },
    ],
  });
  assert.deepEqual(lines.map((l) => [l.kind, l.label, l.amount_cents]), [
    ["bill", "Music", 1_199],
    ["debt", "Card", 25_000],
    ["debt", "Car", 13_846],
    ["spending", "Housing", 85_385],
    ["spending", "Groceries", 24_000],
    ["spending", "Dining", 12_000],
    ["spending", "Subscriptions", 1_755],
    ["savings", "Savings", 27_692],
  ]);
  assert.ok(!lines.some((l) => l.label === "Loan"), "loan is due the 25th, after this period");
  assert.ok(!lines.some((l) => l.label === "Debt payments"), "debts are already listed");
  assert.ok(!lines.some((l) => l.label === "Old gym"), "canceled bills are skipped");

  const totals = paycheckTotals(249_231, lines.map((l) => ({ ...l, done: l.kind === "bill" })));
  assert.equal(totals.assigned_cents, 190_877);
  assert.equal(totals.left_cents, 58_354);
  assert.equal(totals.done_cents, 1_199);
  assert.equal(totals.by_kind.debt, 38_846);

  let n = 0;
  const merged = mergeSuggestions([{ id: "keep", label: "Card", kind: "debt", ref_id: "card", amount_cents: 40_000, done: true }], lines, () => `new-${++n}`);
  assert.equal(merged.length, lines.length, "existing card line is kept, not duplicated");
  assert.equal(merged[0].amount_cents, 40_000);
});

test("sample data plans a paycheck end to end", () => {
  const b = demoBundle("2026-10-01", "u");
  const schedule = scheduleFromSettings(b.settings)!;
  const [next] = paydaysFrom(schedule, "2026-10-01", 1);
  assert.equal(next, "2026-10-10");
  assert.ok(b.debt_plan && b.credit_scores.length === 18);
  const debts = payoffDebts(b.accounts);
  for (const strategy of ["avalanche", "snowball", "custom"] as const) {
    const plan = simulateDebtPlan(plannerInput(debts, b.debt_plan, strategy, "2026-10"));
    assert.equal(plan.is_finite, true, `${strategy} sample plan pays off`);
  }
  assert.ok(b.debt_plan!.lump_sums.every((l) => /^\d{4}-\d{2}$/.test(l.month)) && b.debt_plan!.extra_changes.every((c) => /^\d{4}-\d{2}$/.test(c.month)));
});

/* ---------- credit scores ---------- */

const score = (bureau: CreditScore["bureau"], value: number, as_of: string, model = "FICO 8", id = `${bureau}-${as_of}-${model}`): CreditScore => ({
  id, user_id: "u", bureau, score: value, model, as_of, source: "", note: "", created_at: `${as_of}T00:00:00Z`, updated_at: "",
});

test("bureau summaries compare like with like and flag gaps", () => {
  const scores = [
    score("experian", 700, "2026-06-01"), score("experian", 690, "2026-07-01", "VantageScore 3.0"), score("experian", 724, "2026-09-20"),
    score("equifax", 742, "2026-09-25"), score("equifax", 768, "2026-08-25"),
  ];
  const [eq, ex, tu] = summarizeBureaus(scores, "2026-10-01");
  assert.equal(ex.latest!.score, 724);
  assert.equal(ex.previous!.score, 700, "skips the VantageScore reading");
  assert.equal(ex.change, 24);
  assert.deepEqual([ex.low, ex.high], [690, 724]);
  assert.equal(eq.change, -26);
  assert.equal(tu.latest, null);
  const overview = creditOverview([eq, ex, tu]);
  assert.equal(overview.average, 733);
  assert.equal(overview.spread, 18);
  assert.equal(overview.reported, 2);
  assert.match(overview.insights.join(" "), /Add TransUnion/);
  assert.match(overview.insights.join(" "), /Equifax dropped 26 points/);
  const stale = summarizeBureaus([score("transunion", 600, "2026-05-01"), score("equifax", 700, "2026-09-30")], "2026-10-01");
  assert.equal(stale[2].stale, true);
  const wide = creditOverview(stale);
  assert.match(wide.insights.join(" "), /TransUnion is 100 points below/);
});

test("bands, chart rows and validation", () => {
  assert.equal(scoreBand(800).label, "Exceptional");
  assert.equal(scoreBand(739).label, "Good");
  assert.equal(scoreBand(579).tone, "fail");
  assert.equal(scoreBand(781, "VantageScore 4.0").label, "Excellent");
  assert.equal(scoreBand(640, "vantagescore 3.0").label, "Fair");
  assert.deepEqual(scoreSeries([score("experian", 700, "2026-01-01"), score("equifax", 710, "2026-01-01"), score("experian", 705, "2026-02-01")]), [
    { date: "2026-01-01", experian: 700, equifax: 710 }, { date: "2026-02-01", experian: 705 },
  ]);
  assert.equal(validateScore({ score: 720, as_of: "2026-10-01" }, "2026-10-01"), null);
  assert.match(validateScore({ score: 901, as_of: "2026-10-01" }, "2026-10-01")!, /250 to 900/);
  assert.match(validateScore({ score: 720.5, as_of: "2026-10-01" }, "2026-10-01")!, /250 to 900/);
  assert.match(validateScore({ score: 720, as_of: "2026-10-02" }, "2026-10-01")!, /hasn't happened/);
});
