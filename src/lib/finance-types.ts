/**
 * Personal finance (SPLITTER Finance, which absorbed Folio).
 * Everything here is private to one signed-in account and separate from shared group ledgers.
 * Money is always integer hundredths ("cents") in the account's single finance currency.
 */

export const FINANCE_MAX_CENTS = 1_000_000_000_000;

export type FinanceSettings = {
  user_id: string;
  currency: string;
  /** Monthly gross pay before tax. 0 means "not provided". */
  monthly_gross_cents: number;
  /** Monthly take-home pay. Default planned income for new budget months. */
  monthly_net_cents: number;
  /** Rent or mortgage payment per month (housing rule). */
  housing_cents: number;
  /** Car loan or lease payment per month (car 20/4/10 rule). */
  car_cents: number;
  /** Server flag: Folio's default categories were created once for this account. */
  categories_seeded: boolean;
  /** Pay schedule. Null cycle means not set up yet. */
  pay_cycle: PayCycle | null;
  /** Any known payday (YYYY-MM-DD). Its day of month is the first payday for monthly and twice-monthly pay. */
  pay_anchor: string | null;
  /** Twice-monthly only: the second payday of the month (31 means the last day). */
  pay_day2: number | null;
  /** Usual take-home per paycheck. 0 means not set. */
  paycheck_cents: number;
  created_at: string;
  updated_at: string;
};
export type FinanceProfileInput = Pick<FinanceSettings, "monthly_gross_cents" | "monthly_net_cents" | "housing_cents" | "car_cents">;

/* ---------- accounts (Folio "Wealth") ---------- */
export type AccountType = "checking" | "savings" | "cash" | "investment" | "credit" | "loan";
export const ASSET_TYPES: readonly AccountType[] = ["checking", "savings", "cash", "investment"];
export const LIABILITY_TYPES: readonly AccountType[] = ["credit", "loan"];
export const LIQUID_TYPES: readonly AccountType[] = ["checking", "savings", "cash"];
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  checking: "Checking", savings: "Savings", cash: "Cash", investment: "Investment", credit: "Credit card", loan: "Loan",
};
export function isLiability(type: AccountType): boolean {
  return type === "credit" || type === "loan";
}

export type AccountSource = "manual" | "csv" | "plaid";
export type FinanceAccount = {
  id: string;
  user_id: string;
  name: string;
  institution: string;
  type: AccountType;
  /**
   * Assets: amount held (may be negative for an overdrawn checking account).
   * Liabilities: amount owed, never negative.
   * Investment accounts with holdings are valued from holdings instead (see accountValueCents).
   */
  balance_cents: number;
  last4: string | null;
  /** Liabilities only. Nominal APR in basis points (24.99% = 2499). */
  apr_bps: number | null;
  /** Liabilities only. Required monthly minimum payment. */
  minimum_cents: number | null;
  /** Liabilities only. Whether the payoff planner should include it. */
  in_payoff: boolean;
  source: AccountSource;
  connection_id: string | null;
  created_at: string;
  updated_at: string;
};
export type FinanceAccountInput = Pick<FinanceAccount, "name" | "institution" | "type" | "balance_cents" | "last4" | "apr_bps" | "minimum_cents" | "in_payoff"> & { id?: string };

export type FinanceHolding = {
  id: string;
  user_id: string;
  account_id: string;
  symbol: string;
  name: string;
  /** Decimal string with up to 8 places, e.g. "12.5". */
  shares: string;
  /** Price per share in cents. */
  price_cents: number;
  created_at: string;
  updated_at: string;
};
export type FinanceHoldingInput = Pick<FinanceHolding, "account_id" | "symbol" | "name" | "shares" | "price_cents"> & { id?: string };

/* ---------- categories (persistent across months) ---------- */
export type CategoryKind = "needs" | "wants" | "savings";
export const CATEGORY_KIND_LABEL: Record<CategoryKind, string> = { needs: "Needs", wants: "Wants", savings: "Savings" };
export type FinanceCategory = {
  id: string;
  user_id: string;
  name: string;
  kind: CategoryKind;
  sort: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
};
export type FinanceCategoryInput = Pick<FinanceCategory, "name" | "kind"> & { id?: string; archived?: boolean; sort?: number };

/** Folio's category set, seeded for every new finance account. Order is display order. */
export const DEFAULT_CATEGORIES: readonly { name: string; kind: CategoryKind }[] = [
  { name: "Housing", kind: "needs" },
  { name: "Groceries", kind: "needs" },
  { name: "Utilities", kind: "needs" },
  { name: "Transport", kind: "needs" },
  { name: "Health", kind: "needs" },
  { name: "Debt payments", kind: "needs" },
  { name: "Dining", kind: "wants" },
  { name: "Shopping", kind: "wants" },
  { name: "Subscriptions", kind: "wants" },
  { name: "Entertainment", kind: "wants" },
  { name: "Travel", kind: "wants" },
  { name: "Other", kind: "wants" },
  { name: "Savings", kind: "savings" },
  { name: "Investing", kind: "savings" },
];

/* ---------- budgets (Folio "Plan" envelopes) ---------- */
export type BudgetLimit = { category_id: string; limit_cents: number };
export type BudgetMonth = {
  id: string;
  user_id: string;
  /** YYYY-MM-01 */
  month: string;
  /** Planned take-home income for the month. */
  income_cents: number;
  limits: BudgetLimit[];
  created_at: string;
  updated_at: string;
};
export type BudgetMonthInput = Pick<BudgetMonth, "month" | "income_cents" | "limits">;

/* ---------- ledger (Folio "Activity") ---------- */
export type TxKind = "expense" | "income" | "transfer";
export type TxSource = "manual" | "csv" | "plaid" | "subscription";
export type FinanceTransaction = {
  id: string;
  user_id: string;
  account_id: string | null;
  /** YYYY-MM-DD */
  date: string;
  description: string;
  /** Always a positive magnitude; `kind` gives the direction. */
  amount_cents: number;
  kind: TxKind;
  /** Expenses only. */
  category_id: string | null;
  subscription_id: string | null;
  source: TxSource;
  /** Dedupe key for imports (CSV fingerprint or Plaid transaction id). */
  external_id: string | null;
  pending: boolean;
  created_at: string;
  updated_at: string;
};
export type FinanceTransactionInput = Pick<FinanceTransaction, "date" | "description" | "amount_cents" | "kind"> & {
  id?: string;
  account_id?: string | null;
  category_id?: string | null;
  subscription_id?: string | null;
};
/** One row of a CSV import batch, already validated client-side; the server re-validates. */
export type ImportTransactionInput = Pick<FinanceTransaction, "date" | "description" | "amount_cents" | "kind"> & {
  category_id: string | null;
  external_id: string;
};

/* ---------- subscriptions ---------- */
export type SubscriptionCycle = "weekly" | "monthly" | "quarterly" | "yearly";
export type SubscriptionStatus = "active" | "paused" | "canceled";
export type Subscription = {
  id: string;
  user_id: string;
  name: string;
  amount_cents: number;
  cycle: SubscriptionCycle;
  /** First (or any known) billing date; renewals keep its day of month. */
  anchor_date: string;
  status: SubscriptionStatus;
  notes: string;
  category_id: string | null;
  account_id: string | null;
  created_at: string;
  updated_at: string;
};
export type SubscriptionInput = Pick<Subscription, "name" | "amount_cents" | "cycle" | "anchor_date" | "status" | "notes"> & {
  id?: string;
  category_id?: string | null;
  account_id?: string | null;
};

/* ---------- bank connections (Plaid) ---------- */
export type ConnectionStatus = "ok" | "reauth" | "error";
export type FinanceConnection = {
  id: string;
  user_id: string;
  provider: "plaid";
  institution: string;
  status: ConnectionStatus;
  last_synced_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

/* ---------- paychecks ---------- */
export type PayCycle = "weekly" | "biweekly" | "semimonthly" | "monthly";
export type PayScheduleInput = { pay_cycle: PayCycle | null; pay_anchor?: string; pay_day2?: number | null; paycheck_cents?: number };
export type AllocationKind = "bill" | "debt" | "spending" | "savings" | "other";
export type PaycheckAllocation = {
  id: string;
  label: string;
  kind: AllocationKind;
  /** Subscription (bill), liability account (debt) or category (spending/savings). */
  ref_id: string | null;
  amount_cents: number;
  /** Ticked off once it's paid or moved. */
  done: boolean;
};
export type Paycheck = {
  id: string;
  user_id: string;
  pay_date: string;
  amount_cents: number;
  allocations: PaycheckAllocation[];
  note: string;
  received: boolean;
  created_at: string;
  updated_at: string;
};
export type PaycheckInput = Pick<Paycheck, "pay_date" | "amount_cents" | "allocations" | "note" | "received"> & { id?: string };

/* ---------- custom debt plan ---------- */
export type DebtPlanPayment = { account_id: string; monthly_cents: number | null; due_day: number | null };
export type DebtPlanLumpSum = { id: string; month: string; account_id: string | null; amount_cents: number; note: string };
export type DebtPlanSettings = {
  user_id: string;
  strategy: "avalanche" | "snowball" | "custom";
  extra_monthly_cents: number;
  rollover: boolean;
  priority: string[];
  payments: DebtPlanPayment[];
  extra_changes: { month: string; extra_monthly_cents: number }[];
  lump_sums: DebtPlanLumpSum[];
  created_at: string;
  updated_at: string;
};
export type DebtPlanInput = Pick<DebtPlanSettings, "strategy" | "extra_monthly_cents" | "rollover" | "priority" | "payments" | "extra_changes"> & {
  lump_sums: (Omit<DebtPlanLumpSum, "id"> & { id?: string })[];
};

/* ---------- credit scores ---------- */
export type CreditBureau = "equifax" | "experian" | "transunion";
export const CREDIT_BUREAUS: readonly CreditBureau[] = ["equifax", "experian", "transunion"];
export const BUREAU_LABEL: Record<CreditBureau, string> = { equifax: "Equifax", experian: "Experian", transunion: "TransUnion" };
export type CreditScore = {
  id: string;
  user_id: string;
  bureau: CreditBureau;
  score: number;
  /** "FICO 8", "VantageScore 3.0", or blank. */
  model: string;
  as_of: string;
  source: string;
  note: string;
  /** "sync" when read from a bureau site by the score sync, "manual" when typed in. */
  origin?: "manual" | "sync";
  synced_at?: string | null;
  created_at: string;
  updated_at: string;
};
export type CreditScoreInput = Pick<CreditScore, "bureau" | "score" | "model" | "as_of" | "source" | "note"> & { id?: string };

export type FinanceBundle = {
  user_id: string;
  settings: FinanceSettings | null;
  accounts: FinanceAccount[];
  holdings: FinanceHolding[];
  categories: FinanceCategory[];
  budgets: BudgetMonth[];
  transactions: FinanceTransaction[];
  subscriptions: Subscription[];
  connections: FinanceConnection[];
  debt_plan: DebtPlanSettings | null;
  paychecks: Paycheck[];
  credit_scores: CreditScore[];
};

/** Every write is bound to the account and currency that were on screen when the draft opened. */
export type FinanceContext = { userId: string; currency: string };
