'use client';
import {supabaseBrowser} from './supabase/client';
import {friendly,notifyChanged} from './data';
import type {FinanceBundle,FinanceSettings,PersonalDebt,BudgetMonth,BudgetTransaction,Subscription,PersonalDebtInput,BudgetMonthInput,BudgetTransactionInput,SubscriptionInput,FinanceContext} from './finance-types';
const sb=()=>supabaseBrowser();
type Result<T>={data:T|null;error:{message:string}|null};
export class FinanceContextError extends Error {constructor(message='Your signed-in account changed. Reload the app before using your finances.'){super(message);this.name='FinanceContextError';}}
function unwrap<T>(r:Result<T>):T{if(r.error)throw new Error(friendly(r.error.message));return r.data as T;}
async function requireUser(userId:string){const {data,error}=await sb().auth.getUser();if(error||!userId||data.user?.id!==userId)throw new FinanceContextError();}
async function all<T>(table:string,order:string,userId:string):Promise<T[]>{const out:T[]=[];for(let from=0;;from+=1000){const rows=unwrap(await sb().from(table).select('*').eq('user_id',userId).order(order,{ascending:true}).order('id',{ascending:true}).range(from,from+999) as Result<T[]>);out.push(...rows);if(rows.length<1000)return out;}}
export async function loadFinance(userId:string):Promise<FinanceBundle>{
 await requireUser(userId);
 const [settings,debts,budgets,transactions,subscriptions]=await Promise.all([
  sb().from('finance_settings').select('*').eq('user_id',userId).maybeSingle(),all<PersonalDebt>('personal_debts','created_at',userId),all<BudgetMonth>('budget_months','month',userId),all<BudgetTransaction>('budget_transactions','expense_date',userId),all<Subscription>('personal_subscriptions','created_at',userId)]);
 await requireUser(userId);
 return {user_id:userId,settings:unwrap(settings as Result<FinanceSettings|null>),debts,budgets,transactions,subscriptions};
}
async function call<T>(fn:string,args:Record<string,unknown>,context:FinanceContext):Promise<T>{
 await requireUser(context.userId);
 const result=unwrap(await sb().rpc(fn,{...args,p_user:context.userId,p_currency:context.currency}) as Result<T>);
 await requireUser(context.userId);notifyChanged();return result;
}
export const financeApi={
 saveSettings:(context:FinanceContext)=>call<void>('save_finance_settings',{},context),
 saveDebt:(p:PersonalDebtInput,context:FinanceContext)=>call<string>('save_personal_debt',{p},context),
 deleteDebt:(id:string,context:FinanceContext)=>call<void>('delete_personal_debt',{p_id:id},context),
 saveBudget:(p:BudgetMonthInput,context:FinanceContext)=>call<string>('save_budget_month',{p},context),
 saveTransaction:(p:BudgetTransactionInput,context:FinanceContext)=>call<string>('save_budget_transaction',{p},context),
 deleteTransaction:(id:string,context:FinanceContext)=>call<void>('delete_budget_transaction',{p_id:id},context),
 saveSubscription:(p:SubscriptionInput,context:FinanceContext)=>call<string>('save_personal_subscription',{p},context),
 deleteSubscription:(id:string,context:FinanceContext)=>call<void>('delete_personal_subscription',{p_id:id},context),
};
