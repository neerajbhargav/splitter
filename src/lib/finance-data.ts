"use client";
import { supabaseBrowser } from "./supabase/client";
import { friendly, notifyChanged } from "./data";
import type {
  BudgetMonth, BudgetMonthInput, FinanceAccount, FinanceAccountInput, FinanceBundle, FinanceCategory, FinanceCategoryInput,
  FinanceConnection, FinanceContext, FinanceHolding, FinanceHoldingInput, FinanceProfileInput, FinanceSettings, FinanceTransaction,
  FinanceTransactionInput, ImportTransactionInput, Subscription, SubscriptionInput,
} from "./finance-types";

const sb = () => supabaseBrowser();
type Result<T> = { data: T | null; error: { message: string } | null };

/** Thrown when the signed-in account no longer matches the account a view or draft belongs to. */
export class FinanceContextError extends Error {
  constructor(message = "Your signed-in account changed. Reload the app before using your finances.") {
    super(message);
    this.name = "FinanceContextError";
  }
}

function unwrap<T>(response: Result<T>): T {
  if (response.error) throw new Error(friendly(response.error.message));
  return response.data as T;
}

async function requireUser(userId: string) {
  const { data, error } = await sb().auth.getUser();
  if (error || !userId || data.user?.id !== userId) throw new FinanceContextError();
}

/** Owner-filtered, paginated read. RLS already limits rows to the session user; the filter keeps a mid-load account switch from mixing owners. */
async function all<T>(table: string, columns: string, order: string, userId: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = unwrap(await sb().from(table).select(columns).eq("user_id", userId).order(order, { ascending: true }).order("id", { ascending: true }).range(from, from + 999) as unknown as Result<T[]>);
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

const HOLDING_COLUMNS = "id,user_id,account_id,symbol,name,shares::text,price_cents,created_at,updated_at";

export async function loadFinance(userId: string): Promise<FinanceBundle> {
  await requireUser(userId);
  const [settings, accounts, holdings, categories, budgets, transactions, subscriptions, connections] = await Promise.all([
    sb().from("finance_settings").select("*").eq("user_id", userId).maybeSingle(),
    all<FinanceAccount>("finance_accounts", "*", "created_at", userId),
    all<FinanceHolding>("finance_holdings", HOLDING_COLUMNS, "created_at", userId),
    all<FinanceCategory>("finance_categories", "*", "sort", userId),
    all<BudgetMonth>("budget_months", "*", "month", userId),
    all<FinanceTransaction>("finance_transactions", "*", "date", userId),
    all<Subscription>("personal_subscriptions", "*", "created_at", userId),
    all<FinanceConnection>("finance_connections", "id,user_id,provider,institution,status,last_synced_at,error,created_at,updated_at", "created_at", userId),
  ]);
  await requireUser(userId);
  return {
    user_id: userId,
    settings: unwrap(settings as Result<FinanceSettings | null>),
    accounts,
    holdings: holdings.map((holding) => ({ ...holding, shares: String(holding.shares) })),
    categories,
    budgets: budgets.map((budget) => ({ ...budget, month: String(budget.month).slice(0, 10), limits: Array.isArray(budget.limits) ? budget.limits : [] })),
    transactions,
    subscriptions,
    connections,
  };
}

async function call<T>(fn: string, args: Record<string, unknown>, context: FinanceContext): Promise<T> {
  await requireUser(context.userId);
  const result = unwrap(await sb().rpc(fn, { ...args, p_user: context.userId, p_currency: context.currency }) as Result<T>);
  await requireUser(context.userId);
  notifyChanged();
  return result;
}

export type ImportResult = { batch: string | null; inserted: number; skipped: number };

export const financeApi = {
  /** First visit: creates the private workspace and seeds Folio's categories once. */
  ensureWorkspace: (context: FinanceContext) => call<void>("ensure_finance_workspace", {}, context),
  saveSettings: (context: FinanceContext) => call<void>("save_finance_settings", {}, context),
  saveProfile: (p: FinanceProfileInput, context: FinanceContext) => call<void>("save_finance_profile", { p }, context),

  saveAccount: (p: FinanceAccountInput, context: FinanceContext) => call<string>("save_finance_account", { p }, context),
  deleteAccount: (id: string, context: FinanceContext) => call<void>("delete_finance_account", { p_id: id }, context),
  saveHolding: (p: FinanceHoldingInput, context: FinanceContext) => call<string>("save_finance_holding", { p }, context),
  deleteHolding: (id: string, context: FinanceContext) => call<void>("delete_finance_holding", { p_id: id }, context),

  saveCategory: (p: FinanceCategoryInput, context: FinanceContext) => call<string>("save_finance_category", { p }, context),
  deleteCategory: (id: string, reassignTo: string | null, context: FinanceContext) => call<void>("delete_finance_category", { p_id: id, p_reassign: reassignTo }, context),

  saveBudget: (p: BudgetMonthInput, context: FinanceContext) => call<string>("save_budget_month", { p }, context),
  deleteBudget: (id: string, context: FinanceContext) => call<void>("delete_budget_month", { p_id: id }, context),

  saveTransaction: (p: FinanceTransactionInput, context: FinanceContext) => call<string>("save_finance_transaction", { p }, context),
  deleteTransaction: (id: string, context: FinanceContext) => call<void>("delete_finance_transaction", { p_id: id }, context),
  recategorize: (ids: string[], categoryId: string | null, context: FinanceContext) => call<number>("recategorize_finance_transactions", { p_ids: ids, p_category: categoryId }, context),
  importTransactions: (accountId: string | null, rows: ImportTransactionInput[], context: FinanceContext) => call<ImportResult>("import_finance_transactions", { p_account: accountId, p_rows: rows }, context),
  undoImport: (batch: string, context: FinanceContext) => call<number>("undo_finance_import", { p_batch: batch }, context),

  saveSubscription: (p: SubscriptionInput, context: FinanceContext) => call<string>("save_personal_subscription", { p }, context),
  deleteSubscription: (id: string, context: FinanceContext) => call<void>("delete_personal_subscription", { p_id: id }, context),

  deleteConnection: (id: string, context: FinanceContext) => call<void>("delete_finance_connection", { p_connection: id }, context),
};
export type FinanceApi = typeof financeApi;
