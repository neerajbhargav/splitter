'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {LockKeyhole,Wallet,Settings2} from 'lucide-react';
import {useMe,useToast} from '@/components/providers';
import {Loading,Modal} from '@/components/ui';
import {DebtPlanner} from '@/components/finance/DebtPlanner';
import {BudgetAssistant} from '@/components/finance/BudgetAssistant';
import {SubscriptionTracker} from '@/components/finance/SubscriptionTracker';
import {supabaseBrowser} from '@/lib/supabase/client';
import {loadFinance,financeApi,FinanceContextError} from '@/lib/finance-data';
import {useLiveRefresh} from '@/lib/data';
import {CURRENCIES} from '@/lib/format';
import type {FinanceBundle} from '@/lib/finance-types';

type Tab='debt'|'budget'|'subscriptions';
export default function FinancePage(){
 const me=useMe(),toast=useToast();
 const [bundle,setBundle]=useState<FinanceBundle|null>(null),[error,setError]=useState<string|null>(null),[tab,setTab]=useState<Tab>('debt');
 const [settingsUser,setSettingsUser]=useState(me.id);
 const [settings,setSettings]=useState(false),[draftCurrency,setDraftCurrency]=useState('USD'),[saving,setSaving]=useState(false);
 const request=useRef(0);
 const reload=useCallback(async()=>{const id=++request.current;try{const data=await loadFinance(me.id);if(id===request.current){setBundle(data);setError(null);}}catch(e){if(id===request.current){if(e instanceof FinanceContextError)setBundle(null);setError(e instanceof Error?e.message:'Could not load your finances.');}}},[me.id]);
 useEffect(()=>{setBundle(null);setSettings(false);void reload();return()=>{request.current++;};},[reload]);
 useEffect(()=>{const {data}=supabaseBrowser().auth.onAuthStateChange((_event,session)=>{if(session?.user.id!==me.id){request.current++;setBundle(null);setSettings(false);setError('Your signed-in account changed. Reload the app before using your finances.');}});return()=>data.subscription.unsubscribe();},[me.id]);
 useLiveRefresh('personal-finance',[{table:'finance_settings',filter:`user_id=eq.${me.id}`}],reload);
 const safeBundle=bundle?.user_id===me.id?bundle:null;
 const currency=safeBundle?.settings?.currency ?? (/^[A-Z]{3}$/.test(me.profile?.default_currency ?? '') ? me.profile!.default_currency : 'USD');
 const locked=!!safeBundle&&(safeBundle.debts.length>0||safeBundle.budgets.length>0||safeBundle.transactions.length>0||safeBundle.subscriptions.length>0);
 async function saveCurrency(){setSaving(true);try{if(settingsUser!==me.id)throw new FinanceContextError();await financeApi.saveSettings({userId:settingsUser,currency:draftCurrency});await reload();setSettings(false);toast.ok('Finance currency saved');}catch(e){toast.err(e);}finally{setSaving(false);}}
 return <main className="page finance-page">
  <div className="page-head"><div><div className="eyebrow row-flex"><Wallet width={15} height={15}/>Personal tools</div><h1 className="page-title">Your finances</h1><p className="muted">Plan a payoff, give your income a job, and keep recurring costs in sight.</p></div>
   <div className="finance-actions"><span className="badge"><LockKeyhole width={13} height={13}/>Private to you</span><button className="btn btn-sm" onClick={()=>{setDraftCurrency(currency);setSettingsUser(me.id);setSettings(true);}} aria-label="Finance currency settings"><Settings2/>{currency}</button></div>
  </div>
  <p className="hint finance-privacy">Separate from your group balances. Your roommates cannot see these records. Amounts use two decimal places in the selected currency.</p>
  <div className="finance-tabs" role="tablist" aria-label="Personal finance tools">
   {([{id:'debt',label:'Debt payoff'},{id:'budget',label:'Budget'},{id:'subscriptions',label:'Subscriptions'}] as const).map(t=><button id={`finance-tab-${t.id}`} key={t.id} role="tab" aria-controls={`finance-panel-${t.id}`} aria-selected={tab===t.id} className={tab===t.id?'on':''} onClick={()=>setTab(t.id)}>{t.label}</button>)}
  </div>
  {error&&<div className="banner neg" role="alert">{error}<div><button className="btn btn-sm" onClick={()=>{if(error.includes("account changed"))window.location.reload();else void reload();}}>Retry loading</button></div></div>}
  {!safeBundle&&!error?<Loading label="Loading your private finances"/>:safeBundle&&<div id={`finance-panel-${tab}`} role="tabpanel" aria-labelledby={`finance-tab-${tab}`} className="finance-panel">
   {tab==='debt'?<DebtPlanner bundle={safeBundle} currency={currency} userId={me.id} onRefresh={reload}/>:tab==='budget'?<BudgetAssistant bundle={safeBundle} currency={currency} userId={me.id} onRefresh={reload}/>:<SubscriptionTracker bundle={safeBundle} currency={currency} userId={me.id} onRefresh={reload}/>}
  </div>}
  <Modal open={settings} title="Finance currency" onClose={()=>{if(!saving)setSettings(false);}} footer={<><button className="btn" onClick={()=>setSettings(false)} disabled={saving}>Close</button><button className="btn btn-primary" onClick={()=>void saveCurrency()} disabled={locked||saving||!safeBundle||settingsUser!==me.id}>{saving?'Saving...':'Save currency'}</button></>}>
   <div className="stack"><div className="field"><label className="label" htmlFor="finance-currency">Currency for all personal tools</label><select id="finance-currency" className="select" value={draftCurrency} disabled={locked||saving} onChange={e=>setDraftCurrency(e.target.value)}>{Array.from(new Set([...CURRENCIES,currency])).map(c=><option key={c}>{c}</option>)}</select></div><p className="hint">{locked?'Currency is locked while personal-finance records exist. Changing the label would not convert your existing amounts.':'Choose your currency before adding debts, budgets or subscriptions. Group currencies are independent.'}</p><p className="hint">These are planning tools, not debt settlement services or financial advice. No bank, lender or subscription provider is connected.</p></div>
  </Modal>
 </main>;
}
