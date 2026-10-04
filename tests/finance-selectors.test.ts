import { test } from "node:test";
import assert from "node:assert/strict";
import { debtsMissingTerms, isEmptyWorkspace, payoffDebts } from "../src/lib/finance-selectors.ts";
import type { FinanceAccount, FinanceBundle } from "../src/lib/finance-types.ts";

const acct = (o: Partial<FinanceAccount> = {}): FinanceAccount => ({
  id: "a1", name: "Card", type: "credit", balance_cents: 5_000, apr_bps: 2_499, minimum_cents: 2_500,
  in_payoff: true, last4: null, source: "manual", connection_id: null, ...o,
} as FinanceAccount);

const bundle = (o: Partial<FinanceBundle> = {}): FinanceBundle => ({
  user_id: "u", settings: null, accounts: [], holdings: [], categories: [], budgets: [], transactions: [], subscriptions: [], connections: [], debt_plan: null, paychecks: [], credit_scores: [], ...o,
} as FinanceBundle);

test("a card with a zero minimum is missing terms, not planned", () => {
  const list = [acct({ minimum_cents: 0 })];
  assert.equal(payoffDebts(list).length, 0);
  assert.equal(debtsMissingTerms(list).length, 1);
});

test("loans need an APR; complete debts map exactly", () => {
  const loan = acct({ id: "l1", name: "Loan", type: "loan", apr_bps: null });
  assert.equal(debtsMissingTerms([loan]).length, 1);
  assert.equal(payoffDebts([loan]).length, 0);
  const ok = acct({ id: "l1", name: "Loan", type: "loan", balance_cents: 9_000, apr_bps: 700, minimum_cents: 300 });
  assert.deepEqual(payoffDebts([ok]), [{ id: "l1", name: "Loan", balance_cents: 9_000, apr_bps: 700, minimum_cents: 300 }]);
  assert.equal(debtsMissingTerms([ok]).length, 0);
});

test("opted-out, paid-off and asset accounts are in neither list", () => {
  const list = [
    acct({ id: "x", in_payoff: false, apr_bps: null }),
    acct({ id: "y", balance_cents: 0, apr_bps: null }),
    acct({ id: "z", type: "checking", apr_bps: null, minimum_cents: null }),
  ];
  assert.equal(payoffDebts(list).length, 0);
  assert.equal(debtsMissingTerms(list).length, 0);
});

test("isEmptyWorkspace", () => {
  assert.equal(isEmptyWorkspace(bundle()), true);
  assert.equal(isEmptyWorkspace(bundle({ settings: { monthly_net_cents: 100 } as FinanceBundle["settings"] })), false);
});
