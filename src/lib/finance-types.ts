/** Personal finance is account-private, separate from shared group ledgers.
 * Monetary values use the app's exact integer-hundredths model. */
export type FinanceSettings={user_id:string;currency:string;created_at:string;updated_at:string};
export type PersonalDebt={id:string;user_id:string;name:string;balance_cents:number;apr_bps:number;minimum_cents:number;created_at:string;updated_at:string};
export type PersonalDebtInput=Pick<PersonalDebt,'name'|'balance_cents'|'apr_bps'|'minimum_cents'>&{id?:string};
export type BudgetKind='needs'|'wants'|'savings';
export type BudgetCategory={id:string;name:string;kind:BudgetKind;limit_cents:number};
export type BudgetMonth={id:string;user_id:string;month:string;income_cents:number;categories:BudgetCategory[];created_at:string;updated_at:string};
export type BudgetMonthInput=Pick<BudgetMonth,'month'|'income_cents'|'categories'>;
export type BudgetTransaction={id:string;user_id:string;description:string;amount_cents:number;expense_date:string;category_id:string|null;subscription_id:string|null;created_at:string;updated_at:string};
export type BudgetTransactionInput=Pick<BudgetTransaction,'description'|'amount_cents'|'expense_date'>&{id?:string;category_id?:string|null;subscription_id?:string|null};
export type SubscriptionCycle='weekly'|'monthly'|'quarterly'|'yearly';
export type SubscriptionStatus='active'|'paused'|'canceled';
export type Subscription={id:string;user_id:string;name:string;amount_cents:number;cycle:SubscriptionCycle;anchor_date:string;status:SubscriptionStatus;notes:string;created_at:string;updated_at:string};
export type SubscriptionInput=Pick<Subscription,'name'|'amount_cents'|'cycle'|'anchor_date'|'status'|'notes'>&{id?:string};
export type FinanceBundle={user_id:string;settings:FinanceSettings|null;debts:PersonalDebt[];budgets:BudgetMonth[];transactions:BudgetTransaction[];subscriptions:Subscription[]};
export type FinanceContext={userId:string;currency:string};
export type FinanceToolProps={bundle:FinanceBundle;currency:string;userId:string;onRefresh:()=>Promise<void>};
export const FINANCE_MAX_CENTS=1_000_000_000_000;
