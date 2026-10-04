import type { DebtPlan, DebtPlannerDebt, DebtPlannerInput, DebtStrategy } from "./debt-planner.ts";
import { isLiability, type DebtPlanSettings, type FinanceAccount, type FinanceBundle, type FinanceCategory, type FinanceTransaction } from "./finance-types.ts";

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

/**
 * Payoff engine input from the saved plan. Every strategy shares the extra amount, scheduled changes
 * and one-time payments so comparisons stay fair; only Custom uses your own order, payments and rollover.
 */
export function plannerInput(
  debts: DebtPlannerDebt[],
  plan: Pick<DebtPlanSettings, "extra_monthly_cents" | "rollover" | "priority" | "payments" | "extra_changes" | "lump_sums"> | null,
  strategy: DebtStrategy,
  firstMonth: string,
  extraOverride?: number,
): DebtPlannerInput {
  const ids = new Set(debts.map((d) => d.id));
  const input: DebtPlannerInput = {
    debts,
    strategy,
    extra_monthly_cents: extraOverride ?? plan?.extra_monthly_cents ?? 0,
    first_payment_month: firstMonth,
    extra_changes: (plan?.extra_changes ?? []).filter((c) => c.month > firstMonth),
    lump_sums: (plan?.lump_sums ?? []).filter((l) => l.month >= firstMonth).map((l) => ({ month: l.month, debt_id: l.account_id && ids.has(l.account_id) ? l.account_id : null, amount_cents: l.amount_cents })),
  };
  if (strategy === "custom" && plan) {
    input.priority = plan.priority.filter((id) => ids.has(id));
    input.rollover = plan.rollover;
    const payments: Record<string, number> = {};
    for (const p of plan.payments) if (ids.has(p.account_id) && p.monthly_cents) payments[p.account_id] = p.monthly_cents;
    input.payments = payments;
  }
  return input;
}

/** What the plan pays each debt in a given YYYY-MM month (0 once paid off or before the plan starts). */
export function planPaymentLookup(plan: DebtPlan | null): (debtId: string, month: string) => number {
  const byMonth = new Map<string, Map<string, number>>();
  for (const m of plan?.timeline ?? []) byMonth.set(m.month, new Map(m.payments.map((p) => [p.debt_id, Number(p.payment_cents)])));
  const first = plan?.timeline[0]?.month;
  return (debtId, month) => {
    const row = byMonth.get(month) ?? (first && month < first ? byMonth.get(first) : undefined);
    return row?.get(debtId) ?? 0;
  };
}

export function dueDayFor(plan: DebtPlanSettings | null, accountId: string): number | null {
  return plan?.payments.find((p) => p.account_id === accountId)?.due_day ?? null;
}
