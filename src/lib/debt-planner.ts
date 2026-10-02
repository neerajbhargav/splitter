import { FINANCE_MAX_CENTS } from "./finance-types.ts";

export const DEBT_PLAN_MAX_MONTHS = 600;
const MONTHLY_APR_DENOMINATOR = 120_000n;

export type DebtStrategy = "avalanche" | "snowball";
export type DebtPlanStatus = "paid_off" | "negative_amortization" | "month_limit";

/** A saved debt or an unsaved debt-shaped input accepted by the payoff engine. */
export type DebtPlannerDebt = {
  id: string;
  name: string;
  balance_cents: number;
  apr_bps: number;
  minimum_cents: number;
};

export type DebtPlannerInput = {
  debts: DebtPlannerDebt[];
  strategy: DebtStrategy;
  extra_monthly_cents: number;
  first_payment_month: string;
};

export type DebtMonthPayment = {
  debt_id: string;
  payment_cents: bigint;
  interest_cents: bigint;
  ending_balance_cents: bigint;
};

export type DebtPlanMonth = {
  month_number: number;
  month: string;
  opening_balance_cents: bigint;
  interest_cents: bigint;
  payment_cents: bigint;
  ending_balance_cents: bigint;
  payments: DebtMonthPayment[];
};

export type DebtPayoff = {
  debt_id: string;
  name: string;
  order: number;
  payoff_month_number: number;
  payoff_month: string;
  interest_cents: bigint;
};

/**
 * Exact payoff result. Monetary outputs are bigint cents so even a nonpayoff
 * plan with compounding interest cannot overflow or silently lose cents.
 */
export type DebtPlan = {
  strategy: DebtStrategy;
  status: DebtPlanStatus;
  is_finite: boolean;
  first_payment_month: string;
  months: number | null;
  payoff_month: string | null;
  total_balance_cents: bigint;
  monthly_commitment_cents: bigint;
  estimated_interest_cents: bigint;
  ending_balance_cents: bigint;
  payoff_order: DebtPayoff[];
  timeline: DebtPlanMonth[];
};

export type DebtPlanComparison = {
  plan: DebtPlan;
  baseline: DebtPlan;
  interest_saved_cents: bigint | null;
  months_saved: number | null;
};

type DebtState = {
  id: string;
  name: string;
  balance: bigint;
  aprBps: bigint;
  minimum: bigint;
  inputIndex: number;
  interest: bigint;
};

function assertSafeInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be a safe integer from ${min} to ${max}`);
  }
}

function normalize(input: DebtPlannerInput): DebtState[] {
  if (input.strategy !== "avalanche" && input.strategy !== "snowball") throw new RangeError("Unknown debt payoff strategy");
  assertSafeInteger(input.extra_monthly_cents, "Extra monthly amount", 0, FINANCE_MAX_CENTS);
  validatePaymentMonth(input.first_payment_month);
  const ids = new Set<string>();
  return input.debts.map((debt, inputIndex) => {
    if (!debt.id || ids.has(debt.id)) throw new RangeError("Every debt needs a unique id");
    ids.add(debt.id);
    assertSafeInteger(debt.balance_cents, `${debt.name || "Debt"} balance`, 0, FINANCE_MAX_CENTS);
    assertSafeInteger(debt.minimum_cents, `${debt.name || "Debt"} minimum`, 1, FINANCE_MAX_CENTS);
    assertSafeInteger(debt.apr_bps, `${debt.name || "Debt"} APR`, 0, 100_000);
    return {
      id: debt.id,
      name: debt.name.trim() || "Debt",
      balance: BigInt(debt.balance_cents),
      aprBps: BigInt(debt.apr_bps),
      minimum: BigInt(debt.minimum_cents),
      inputIndex,
      interest: 0n,
    };
  });
}

/** Monthly nominal APR interest, rounded half up to the nearest cent. */
export function monthlyInterestCents(balanceCents: bigint, aprBps: number | bigint): bigint {
  if (balanceCents < 0n) throw new RangeError("Balance cannot be negative");
  const bps = typeof aprBps === "bigint" ? aprBps : BigInt(aprBps);
  if (bps < 0n || bps > 100_000n) throw new RangeError("APR must be from 0 to 100000 basis points");
  const numerator = balanceCents * bps;
  return (numerator + MONTHLY_APR_DENOMINATOR / 2n) / MONTHLY_APR_DENOMINATOR;
}

/** Strict YYYY-MM validation, limited so every 600-month plan has representable dates. */
export function validatePaymentMonth(month: string): void {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new RangeError("First payment month must use YYYY-MM");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (year < 1 || year > 9949 || monthNumber < 1 || monthNumber > 12) {
    throw new RangeError("First payment month is outside the supported calendar range");
  }
}

/** Adds calendar months without Date parsing, time zones, or end-of-month rollover. */
export function addCalendarMonths(month: string, offset: number): string {
  validatePaymentMonth(month);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= DEBT_PLAN_MAX_MONTHS) throw new RangeError("Month offset is outside the payoff range");
  const [year, monthNumber] = month.split("-").map(Number);
  const index = year * 12 + monthNumber - 1 + offset;
  const nextYear = Math.floor(index / 12);
  const nextMonth = index % 12 + 1;
  if (nextYear > 9999) throw new RangeError("Payoff month is outside the supported calendar range");
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}

function priority(a: DebtState, b: DebtState, strategy: DebtStrategy): number {
  if (strategy === "avalanche") {
    if (a.aprBps !== b.aprBps) return a.aprBps > b.aprBps ? -1 : 1;
  } else if (a.balance !== b.balance) {
    return a.balance < b.balance ? -1 : 1;
  }
  return a.inputIndex - b.inputIndex || a.id.localeCompare(b.id);
}

function totalBalance(states: DebtState[]): bigint {
  return states.reduce((sum, debt) => sum + debt.balance, 0n);
}

/** Simulates one strategy for at most 600 payments. */
export function simulateDebtPlan(input: DebtPlannerInput): DebtPlan {
  const states = normalize(input);
  const totalBalanceCents = totalBalance(states);
  const monthlyCommitment = states.reduce((sum, debt) => sum + debt.minimum, BigInt(input.extra_monthly_cents));
  const timeline: DebtPlanMonth[] = [];
  const payoffOrder: DebtPayoff[] = [];

  if (totalBalanceCents === 0n) {
    return {
      strategy: input.strategy,
      status: "paid_off",
      is_finite: true,
      first_payment_month: input.first_payment_month,
      months: 0,
      payoff_month: null,
      total_balance_cents: 0n,
      monthly_commitment_cents: monthlyCommitment,
      estimated_interest_cents: 0n,
      ending_balance_cents: 0n,
      payoff_order: [],
      timeline: [],
    };
  }

  for (let monthIndex = 0; monthIndex < DEBT_PLAN_MAX_MONTHS && totalBalance(states) > 0n; monthIndex++) {
    const month = addCalendarMonths(input.first_payment_month, monthIndex);
    const openingBalance = totalBalance(states);
    const monthInterest = new Map<string, bigint>();
    const monthPayments = new Map<string, bigint>();

    for (const debt of states) {
      if (debt.balance === 0n) continue;
      const interest = monthlyInterestCents(debt.balance, debt.aprBps);
      debt.balance += interest;
      debt.interest += interest;
      monthInterest.set(debt.id, interest);
      monthPayments.set(debt.id, 0n);
    }

    let available = monthlyCommitment;
    for (const debt of states) {
      if (debt.balance === 0n || available === 0n) continue;
      const payment = debt.balance < debt.minimum ? debt.balance : debt.minimum;
      debt.balance -= payment;
      available -= payment;
      monthPayments.set(debt.id, (monthPayments.get(debt.id) ?? 0n) + payment);
    }

    while (available > 0n) {
      const target = states.filter((debt) => debt.balance > 0n).sort((a, b) => priority(a, b, input.strategy))[0];
      if (!target) break;
      const payment = target.balance < available ? target.balance : available;
      target.balance -= payment;
      available -= payment;
      monthPayments.set(target.id, (monthPayments.get(target.id) ?? 0n) + payment);
    }

    const paidThisMonth = states
      .filter((debt) => debt.balance === 0n && (monthPayments.get(debt.id) ?? 0n) > 0n && !payoffOrder.some((p) => p.debt_id === debt.id))
      .sort((a, b) => priority(a, b, input.strategy));
    for (const debt of paidThisMonth) {
      payoffOrder.push({
        debt_id: debt.id,
        name: debt.name,
        order: payoffOrder.length + 1,
        payoff_month_number: monthIndex + 1,
        payoff_month: month,
        interest_cents: debt.interest,
      });
    }

    const payments: DebtMonthPayment[] = states.map((debt) => ({
      debt_id: debt.id,
      payment_cents: monthPayments.get(debt.id) ?? 0n,
      interest_cents: monthInterest.get(debt.id) ?? 0n,
      ending_balance_cents: debt.balance,
    }));
    const interestCents = payments.reduce((sum, row) => sum + row.interest_cents, 0n);
    const paymentCents = payments.reduce((sum, row) => sum + row.payment_cents, 0n);
    timeline.push({
      month_number: monthIndex + 1,
      month,
      opening_balance_cents: openingBalance,
      interest_cents: interestCents,
      payment_cents: paymentCents,
      ending_balance_cents: totalBalance(states),
      payments,
    });
  }

  const endingBalance = totalBalance(states);
  const isFinite = endingBalance === 0n;
  const estimatedInterest = states.reduce((sum, debt) => sum + debt.interest, 0n);
  // This is a deliberately conservative impossibility flag. If even the entire
  // fixed monthly budget cannot cover one active debt's next month of interest,
  // that debt cannot shrink under either ordering. Other long plans remain a
  // neutral month-limit result rather than being called unaffordable.
  const cannotCoverInterest = states.some((debt) => debt.balance > 0n
    && monthlyInterestCents(debt.balance, debt.aprBps) >= monthlyCommitment);
  const status: DebtPlanStatus = isFinite ? "paid_off" : cannotCoverInterest ? "negative_amortization" : "month_limit";
  return {
    strategy: input.strategy,
    status,
    is_finite: isFinite,
    first_payment_month: input.first_payment_month,
    months: isFinite ? timeline.length : null,
    payoff_month: isFinite && timeline.length ? timeline[timeline.length - 1].month : null,
    total_balance_cents: totalBalanceCents,
    monthly_commitment_cents: monthlyCommitment,
    estimated_interest_cents: estimatedInterest,
    ending_balance_cents: endingBalance,
    payoff_order: payoffOrder,
    timeline,
  };
}

/** Runs the requested plan and a no-extra baseline. Savings exist only when both finish. */
export function compareDebtPlans(input: DebtPlannerInput): DebtPlanComparison {
  const plan = simulateDebtPlan(input);
  const baseline = simulateDebtPlan({ ...input, extra_monthly_cents: 0 });
  if (!plan.is_finite || !baseline.is_finite || plan.months === null || baseline.months === null) {
    return { plan, baseline, interest_saved_cents: null, months_saved: null };
  }
  return {
    plan,
    baseline,
    interest_saved_cents: baseline.estimated_interest_cents > plan.estimated_interest_cents
      ? baseline.estimated_interest_cents - plan.estimated_interest_cents
      : 0n,
    months_saved: Math.max(0, baseline.months - plan.months),
  };
}

export const calculateDebtPlan = simulateDebtPlan;
