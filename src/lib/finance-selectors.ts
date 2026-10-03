import type { DebtPlannerDebt } from "./debt-planner.ts";
import { isLiability, type FinanceAccount, type FinanceBundle, type FinanceCategory, type FinanceTransaction } from "./finance-types.ts";

/** Liabilities the payoff planner can model: still owed, opted in, with APR and minimum known. */
export function payoffDebts(accounts: readonly FinanceAccount[]): DebtPlannerDebt[] {
  return accounts
    .filter((a) => isLiability(a.type) && a.in_payoff && a.balance_cents > 0 && a.apr_bps !== null && a.minimum_cents !== null && a.minimum_cents > 0)
    .map((a) => ({ id: a.id, name: a.name, balance_cents: a.balance_cents, apr_bps: a.apr_bps!, minimum_cents: a.minimum_cents! }));
}

/** Owed balances that cannot be planned yet because APR or minimum is missing. */
export function debtsMissingTerms(accounts: readonly FinanceAccount[]): FinanceAccount[] {
  return accounts.filter((a) => isLiability(a.type) && a.in_payoff && a.balance_cents > 0 && (a.apr_bps === null || a.minimum_cents === null || a.minimum_cents <= 0));
}

export function categoryLookup(categories: readonly FinanceCategory[]): Map<string, FinanceCategory> {
  return new Map(categories.map((c) => [c.id, c]));
}

export function sortTransactions(transactions: readonly FinanceTransaction[]): FinanceTransaction[] {
  return [...transactions].sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

/** Nothing entered yet: show onboarding instead of empty dashboards. */
export function isEmptyWorkspace(bundle: FinanceBundle): boolean {
  const s = bundle.settings;
  return !bundle.accounts.length && !bundle.transactions.length && !bundle.subscriptions.length
    && !bundle.budgets.some((b) => b.limits.length > 0 || b.income_cents > 0)
    && !(s && (s.monthly_gross_cents || s.monthly_net_cents));
}
