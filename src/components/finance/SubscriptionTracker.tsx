'use client';
import {useEffect,useMemo,useState,type FormEvent} from 'react';
import {Archive,CalendarClock,CirclePause,CirclePlay,Pencil,Plus,ReceiptText,Search,XCircle} from 'lucide-react';
import {Empty,Modal,Segmented} from '../ui';
import {useToast} from '../providers';
import {financeApi} from '@/lib/finance-data';
import type {BudgetCategory,FinanceContext,FinanceToolProps,Subscription,SubscriptionCycle,SubscriptionStatus} from '@/lib/finance-types';
import {FINANCE_MAX_CENTS} from '@/lib/finance-types';
import {centsToInput,longDate,money,todayISO} from '@/lib/format';
import {parseMoney} from '@/lib/split';
import {
 forecastSubscriptionCharges,forecastTotalCents,isValidCalendarDate,nextRenewalDate,
 subscriptionEquivalent,subscriptionEquivalentTotals,validateSubscription,
} from '@/lib/subscription-planner';

const CYCLES:{id:SubscriptionCycle;label:string}[]=[
 {id:'weekly',label:'Weekly'},{id:'monthly',label:'Monthly'},{id:'quarterly',label:'Quarterly'},{id:'yearly',label:'Yearly'},
];
const STATUS_LABEL:Record<SubscriptionStatus,string>={active:'Active',paused:'Paused',canceled:'Canceled'};
type StatusFilter='all'|SubscriptionStatus;
type EditorAction={subscription:Subscription|null;context:FinanceContext};
type LogAction={subscription:Subscription;context:FinanceContext};
type ConfirmAction={kind:'cancel'|'archive';subscription:Subscription;context:FinanceContext};
const CONTEXT_CHANGED='Your finance account or currency changed. Close this dialog and reopen it before saving.';
function sameFinanceContext(a:FinanceContext,b:FinanceContext):boolean{return a.userId===b.userId&&a.currency===b.currency;}

function bigMoney(cents:bigint,currency:string):string{
 const negative=cents<0n,magnitude=negative?-cents:cents;
 const decimal=`${negative?'-':''}${magnitude/100n}.${String(magnitude%100n).padStart(2,'0')}`;
 try{return new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(decimal as unknown as number);}
 catch{return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(decimal as unknown as number);}
}
function cycleLabel(cycle:SubscriptionCycle):string{return CYCLES.find(item=>item.id===cycle)?.label??cycle;}
function readableError(error:unknown):string{
 const message=error instanceof Error?error.message:String(error);
 if(/duplicate|unique|same subscription.*same day|already.*logged/i.test(message))return 'A charge for this subscription is already logged on that date.';
 return message;
}
function monthName(iso:string):string{
 const [year,month]=iso.split('-').map(Number);
 return new Date(year,month-1,1,12).toLocaleDateString('en-US',{month:'long',year:'numeric'});
}

export function SubscriptionTracker({bundle,currency,userId,onRefresh}:FinanceToolProps){
 const toast=useToast();
 const today=todayISO();
 const currentContext:FinanceContext={userId,currency};
 const [query,setQuery]=useState('');
 const [filter,setFilter]=useState<StatusFilter>('all');
 const [editor,setEditor]=useState<EditorAction|null>(null);
 const [logTarget,setLogTarget]=useState<LogAction|null>(null);
 const [confirm,setConfirm]=useState<ConfirmAction|null>(null);
 const [actionBusy,setActionBusy]=useState<string|null>(null);

 const active=bundle.subscriptions.filter(subscription=>subscription.status==='active');
 const equivalents=useMemo(()=>subscriptionEquivalentTotals(bundle.subscriptions),[bundle.subscriptions]);
 const forecast=useMemo(()=>forecastSubscriptionCharges(bundle.subscriptions,today,30),[bundle.subscriptions,today]);
 const forecastTotal=useMemo(()=>forecastTotalCents(forecast),[forecast]);
 const chargesBySubscription=useMemo(()=>{
  const map=new Map<string,{count:number;last:string|null}>();
  for(const transaction of bundle.transactions){
   if(!transaction.subscription_id)continue;
   const previous=map.get(transaction.subscription_id)??{count:0,last:null};
   map.set(transaction.subscription_id,{count:previous.count+1,last:previous.last===null||transaction.expense_date>previous.last?transaction.expense_date:previous.last});
  }
  return map;
 },[bundle.transactions]);
 const visible=useMemo(()=>{
  const normalized=query.trim().toLowerCase();
  return bundle.subscriptions.filter(subscription=>(filter==='all'||subscription.status===filter)&&(!normalized||subscription.name.toLowerCase().includes(normalized)||subscription.notes.toLowerCase().includes(normalized)))
   .sort((a,b)=>{
    const aNext=a.status==='active'?nextRenewalDate(a.anchor_date,a.cycle,today):null;
    const bNext=b.status==='active'?nextRenewalDate(b.anchor_date,b.cycle,today):null;
    if(aNext&&bNext&&aNext!==bNext)return aNext.localeCompare(bNext);
    if(aNext&&!bNext)return -1;
    if(!aNext&&bNext)return 1;
    return a.name.localeCompare(b.name);
   });
 },[bundle.subscriptions,filter,query,today]);
 const counts=useMemo(()=>({
  all:bundle.subscriptions.length,
  active:active.length,
  paused:bundle.subscriptions.filter(subscription=>subscription.status==='paused').length,
  canceled:bundle.subscriptions.filter(subscription=>subscription.status==='canceled').length,
 }),[active.length,bundle.subscriptions]);

 async function setStatus(subscription:Subscription,status:SubscriptionStatus,context:FinanceContext){
  if(!sameFinanceContext(context,currentContext)){toast.err(new Error(CONTEXT_CHANGED));return;}
  setActionBusy(subscription.id);
  try{
   await financeApi.saveSubscription({id:subscription.id,name:subscription.name,amount_cents:subscription.amount_cents,cycle:subscription.cycle,anchor_date:subscription.anchor_date,status,notes:subscription.notes},context);
   await onRefresh();
   toast.ok(status==='paused'?`${subscription.name} paused in your tracker`:status==='active'?`${subscription.name} resumed in your tracker`:`${subscription.name} marked canceled in your tracker`);
  }catch(error){toast.err(error);}finally{setActionBusy(null);setConfirm(null);}
 }
 async function archiveSubscription(subscription:Subscription,context:FinanceContext){
  if(!sameFinanceContext(context,currentContext)){toast.err(new Error(CONTEXT_CHANGED));return;}
  setActionBusy(subscription.id);
  try{await financeApi.deleteSubscription(subscription.id,context);await onRefresh();toast.ok(`${subscription.name} archived`);}
  catch(error){toast.err(error);}finally{setActionBusy(null);setConfirm(null);}
 }

 return <section className="finance-tool stack">
  <div className="between">
   <div><h2>Subscriptions</h2><p className="muted">Private manual tracker. All amounts use your account currency, {currency}.</p></div>
   <button type="button" className="btn btn-primary" onClick={()=>setEditor({subscription:null,context:{userId,currency}})}><Plus/> Add subscription</button>
  </div>

  <div className="finance-stats">
   <div className="finance-stat"><span className="faint">Monthly equivalent</span><strong className="num">{bigMoney(equivalents.monthly_cents,currency)}</strong><small>Estimated</small></div>
   <div className="finance-stat"><span className="faint">Yearly equivalent</span><strong className="num">{bigMoney(equivalents.yearly_cents,currency)}</strong><small>Estimated</small></div>
   <div className="finance-stat"><span className="faint">Next 30 days</span><strong className="num">{bigMoney(forecastTotal,currency)}</strong><small>{forecast.length} scheduled charge{forecast.length===1?'':'s'}</small></div>
   <div className="finance-stat"><span className="faint">Active</span><strong className="num">{active.length}</strong><small>{bundle.subscriptions.length} tracked</small></div>
  </div>
  <p className="hint">Equivalent estimates use weekly ×52/year, monthly ×12/year, quarterly ×4/year, and yearly ×1. The 30-day forecast uses actual anchor dates and does not automatically book expenses.</p>

  <div className="card">
   <div className="card-head between"><div><div className="card-title">Upcoming on this page</div><div className="card-desc">Scheduled renewals over the next 30 calendar days. No browser notifications are sent.</div></div><CalendarClock/></div>
   <div className="card-body">
    {!forecast.length?<Empty title="No active renewals in the next 30 days">Paused and canceled subscriptions are excluded.</Empty>:
     <div className="finance-scroll"><table className="finance-table"><thead><tr><th>Date</th><th>Subscription</th><th>Amount</th></tr></thead><tbody>
      {forecast.map((charge,index)=><tr key={`${charge.subscription_id}-${charge.date}-${index}`}><td>{longDate(charge.date)}</td><td>{charge.name}</td><td className="num">{money(charge.amount_cents,currency)}</td></tr>)}
     </tbody></table></div>}
   </div>
  </div>

  <div className="between">
   <Segmented<StatusFilter> value={filter} onChange={setFilter} options={([
    ['all',`All ${counts.all}`],['active',`Active ${counts.active}`],['paused',`Paused ${counts.paused}`],['canceled',`Canceled ${counts.canceled}`],
   ] as [StatusFilter,string][]).map(([id,label])=>({id,label}))}/>
   <label className="field" style={{margin:0}}><span style={{position:'relative',display:'block'}}><Search width={16} aria-hidden style={{position:'absolute',left:10,top:10}}/><input className="input" aria-label="Search subscriptions" style={{paddingLeft:34}} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search subscriptions"/></span></label>
  </div>

  {!bundle.subscriptions.length?<div className="card"><div className="card-body"><Empty title="No subscriptions yet" action={<button type="button" className="btn btn-primary" onClick={()=>setEditor({subscription:null,context:{userId,currency}})}><Plus/> Add one manually</button>}>Track renewals without connecting a bank or merchant.</Empty></div></div>:
   !visible.length?<div className="card"><div className="card-body"><Empty title="No matching subscriptions">Try another search or status filter.</Empty></div></div>:
   <div className="card"><div className="card-body" style={{paddingTop:0,paddingBottom:0}}>{visible.map(subscription=>{
    const equivalent=subscriptionEquivalent(subscription.amount_cents,subscription.cycle);
    const next=subscription.status==='active'?nextRenewalDate(subscription.anchor_date,subscription.cycle,today):null;
    const logged=chargesBySubscription.get(subscription.id);
    return <div className="finance-list-row" key={subscription.id}>
     <div className="stack" style={{gap:4,minWidth:0}}>
      <div className="between"><strong className="ellipsis">{subscription.name}</strong><span className={`badge ${subscription.status==='active'?'pos':subscription.status==='canceled'?'neg':''}`}>{STATUS_LABEL[subscription.status]}</span></div>
      <span className="muted">{money(subscription.amount_cents,currency)} {cycleLabel(subscription.cycle).toLowerCase()} · anchor {longDate(subscription.anchor_date)}</span>
      <span className="hint">≈ {bigMoney(equivalent.monthly_cents,currency)}/month · {bigMoney(equivalent.yearly_cents,currency)}/year</span>
      <span className="hint">{next?`Next renewal ${longDate(next)}`:subscription.status==='paused'?'Renewal forecast paused':'No future renewal forecast'}{logged?.count?` · ${logged.count} logged charge${logged.count===1?'':'s'}, last ${longDate(logged.last!)}`:' · no logged charges'}</span>
      {subscription.notes&&<span className="muted">{subscription.notes}</span>}
     </div>
     <div className="finance-actions">
      <button type="button" className="btn btn-ghost" onClick={()=>setLogTarget({subscription,context:{userId,currency}})} disabled={actionBusy===subscription.id}><ReceiptText/> Log charge</button>
      <button type="button" className="btn btn-ghost" onClick={()=>setEditor({subscription,context:{userId,currency}})} disabled={actionBusy===subscription.id}><Pencil/> Edit</button>
      {subscription.status==='active'&&<button type="button" className="btn btn-ghost" onClick={()=>void setStatus(subscription,'paused',{userId,currency})} disabled={actionBusy===subscription.id}><CirclePause/> Pause</button>}
      {subscription.status==='paused'&&<button type="button" className="btn btn-ghost" onClick={()=>void setStatus(subscription,'active',{userId,currency})} disabled={actionBusy===subscription.id}><CirclePlay/> Resume</button>}
      {subscription.status!=='canceled'&&<button type="button" className="btn btn-ghost" onClick={()=>setConfirm({kind:'cancel',subscription,context:{userId,currency}})} disabled={actionBusy===subscription.id}><XCircle/> Mark canceled</button>}
      {subscription.status==='canceled'&&<button type="button" className="btn btn-ghost" onClick={()=>setConfirm({kind:'archive',subscription,context:{userId,currency}})} disabled={actionBusy===subscription.id}><Archive/> Archive</button>}
     </div>
    </div>;
   })}</div></div>}

  {editor&&<SubscriptionEditor subscription={editor.subscription} context={editor.context} currentContext={currentContext} onClose={()=>setEditor(null)} onSaved={async()=>{setEditor(null);await onRefresh();}}/>}
  {logTarget&&<LogCharge subscription={logTarget.subscription} context={logTarget.context} currentContext={currentContext} bundle={bundle} onClose={()=>setLogTarget(null)} onSaved={async()=>{setLogTarget(null);await onRefresh();}}/>}
  <Modal open={confirm!==null} onClose={()=>{if(!actionBusy)setConfirm(null);}} title={confirm?.kind==='cancel'?'Mark subscription canceled?':'Archive subscription?'} footer={confirm&&!sameFinanceContext(confirm.context,currentContext)?<button type="button" className="btn btn-primary" onClick={()=>setConfirm(null)}>Close and reopen</button>:<>
   <button type="button" className="btn btn-ghost" onClick={()=>setConfirm(null)} disabled={!!actionBusy}>Keep it</button>
   <button type="button" className={confirm?.kind==='archive'?'btn btn-danger':'btn btn-primary'} disabled={!confirm||!!actionBusy} onClick={()=>{if(!confirm)return;void(confirm.kind==='cancel'?setStatus(confirm.subscription,'canceled',confirm.context):archiveSubscription(confirm.subscription,confirm.context));}}>{actionBusy?'Saving...':confirm?.kind==='archive'?'Archive':'Mark canceled'}</button>
  </>}>
   <div className="stack">{confirm&&!sameFinanceContext(confirm.context,currentContext)?<div className="banner neg">{CONTEXT_CHANGED}</div>:<><p>{confirm?.kind==='cancel'?<>This only changes your private tracker. It does <b>not</b> cancel the subscription with the merchant.</>:<>This removes the canceled subscription from the tracker. Previously logged budget charges remain.</>}</p>{confirm&&<p className="muted"><b>{confirm.subscription.name}</b> · {money(confirm.subscription.amount_cents,confirm.context.currency)} {confirm.subscription.cycle}</p>}</>}</div>
  </Modal>
 </section>;
}

function SubscriptionEditor({subscription,context,currentContext,onClose,onSaved}:{subscription:Subscription|null;context:FinanceContext;currentContext:FinanceContext;onClose:()=>void;onSaved:()=>Promise<void>}){
 const toast=useToast();
 const [name,setName]=useState('');
 const [amount,setAmount]=useState('');
 const [cycle,setCycle]=useState<SubscriptionCycle>('monthly');
 const [anchor,setAnchor]=useState(todayISO());
 const [notes,setNotes]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const contextChanged=!sameFinanceContext(context,currentContext);
 useEffect(()=>{setName(subscription?.name??'');setAmount(subscription?centsToInput(subscription.amount_cents):'');setCycle(subscription?.cycle??'monthly');setAnchor(subscription?.anchor_date??todayISO());setNotes(subscription?.notes??'');setError(null);},[subscription]);
 async function submit(event:FormEvent){
  event.preventDefault();
  if(contextChanged){setError(CONTEXT_CHANGED);return;}
  const amountCents=parseMoney(amount);
  if(amountCents===null){setError('Enter an amount from 0 to 10,000,000,000.00');return;}
  const values={name:name.trim(),amount_cents:amountCents,cycle,anchor_date:anchor,status:subscription?.status??'active' as SubscriptionStatus};
  const invalid=validateSubscription(values);
  if(invalid){setError(invalid);return;}
  if(notes.length>500){setError('Notes can be up to 500 characters');return;}
  setBusy(true);setError(null);
  try{
   await financeApi.saveSubscription({id:subscription?.id,...values,notes:notes.trim()},context);
   toast.ok(subscription?'Subscription updated':'Subscription added');
   await onSaved();
  }catch(reason){setError(readableError(reason));}finally{setBusy(false);}
 }
 return <Modal open onClose={()=>{if(!busy)onClose();}} title={subscription?'Edit subscription':'Add subscription'} footer={contextChanged?<button type="button" className="btn btn-primary" onClick={onClose}>Close and reopen</button>:<><button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="subscription-editor-form" className="btn btn-primary" disabled={busy}>{busy?'Saving...':subscription?'Save changes':'Add subscription'}</button></>}>
  <form id="subscription-editor-form" className="stack" onSubmit={submit}>
   {contextChanged&&<div className="banner neg">{CONTEXT_CHANGED}</div>}
   <div className="field"><label className="label" htmlFor="subscription-name">Name</label><input id="subscription-name" className="input" value={name} onChange={event=>setName(event.target.value)} placeholder="Subscription name" maxLength={100} disabled={contextChanged} autoFocus/></div>
   <div className="form-row">
    <div className="field"><label className="label" htmlFor="subscription-amount">Amount ({context.currency})</label><input id="subscription-amount" className="input num" inputMode="decimal" value={amount} onChange={event=>setAmount(event.target.value)} placeholder="0.00" disabled={contextChanged}/><span className="hint">Free subscriptions may use 0.00.</span></div>
    <div className="field"><label className="label" htmlFor="subscription-cycle">Billing cycle</label><select id="subscription-cycle" className="input" value={cycle} onChange={event=>setCycle(event.target.value as SubscriptionCycle)} disabled={contextChanged}>{CYCLES.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
   </div>
   <div className="field"><label className="label" htmlFor="subscription-anchor">First scheduled renewal / anchor</label><input id="subscription-anchor" type="date" className="input" min="1900-01-01" max="2200-12-31" value={anchor} onChange={event=>setAnchor(event.target.value)} disabled={contextChanged}/><span className="hint">Past anchors are fine. Future renewals preserve the original day, including month-end and leap-day schedules.</span></div>
   <div className="field"><label className="label" htmlFor="subscription-notes">Notes</label><textarea id="subscription-notes" className="textarea" rows={3} value={notes} onChange={event=>setNotes(event.target.value)} placeholder="Optional notes" maxLength={500} disabled={contextChanged}/></div>
   {error&&<div className="banner neg">{error}</div>}
  </form>
 </Modal>;
}

function LogCharge({subscription,context,currentContext,bundle,onClose,onSaved}:{subscription:Subscription;context:FinanceContext;currentContext:FinanceContext;bundle:FinanceToolProps['bundle'];onClose:()=>void;onSaved:()=>Promise<void>}){
 const toast=useToast();
 const today=todayISO();
 const [amount,setAmount]=useState('');
 const [date,setDate]=useState(today);
 const [category,setCategory]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const contextChanged=!sameFinanceContext(context,currentContext);
 useEffect(()=>{setAmount(subscription.amount_cents>0?centsToInput(subscription.amount_cents):'');setDate(todayISO());setCategory('');setError(null);},[subscription]);
 const budget=contextChanged?undefined:bundle.budgets.find(item=>item.month===date.slice(0,7));
 const categories:BudgetCategory[]=budget?.categories??[];
 async function submit(event:FormEvent){
  event.preventDefault();
  if(contextChanged){setError(CONTEXT_CHANGED);return;}
  const amountCents=parseMoney(amount);
  if(amountCents===null||amountCents<=0||amountCents>FINANCE_MAX_CENTS){setError('Enter an actual charge greater than 0 and no more than 10,000,000,000.00');return;}
  if(!isValidCalendarDate(date)||date>today){setError('Choose a valid charge date no later than today');return;}
  if(bundle.transactions.some(transaction=>transaction.subscription_id===subscription.id&&transaction.expense_date===date)){setError('A charge for this subscription is already logged on that date.');return;}
  if(category&&!categories.some(item=>item.id===category)){setError('Choose a category from that budget month, or use Uncategorized');return;}
  setBusy(true);setError(null);
  try{
   await financeApi.saveTransaction({description:subscription.name,amount_cents:amountCents,expense_date:date,category_id:category||null,subscription_id:subscription.id},context);
   toast.ok(`Charge logged in ${monthName(date)} Budget`);
   await onSaved();
  }catch(reason){setError(readableError(reason));}finally{setBusy(false);}
 }
 return <Modal open onClose={()=>{if(!busy)onClose();}} title="Log charge to Budget" footer={contextChanged?<button type="button" className="btn btn-primary" onClick={onClose}>Close and reopen</button>:<><button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="subscription-charge-form" className="btn btn-primary" disabled={busy}>{busy?'Logging...':'Log charge'}</button></>}>
  {contextChanged?<div className="banner neg">{CONTEXT_CHANGED}</div>:<form id="subscription-charge-form" className="stack" onSubmit={submit}>
   <div className="banner"><ReceiptText/>This records an actual expense in Budget. It does not pay the merchant, change the renewal forecast, or create future expenses.</div>
   <p><b>{subscription.name}</b></p>
   <div className="form-row">
    <div className="field"><label className="label" htmlFor="charge-amount">Actual amount ({context.currency})</label><input id="charge-amount" className="input num" inputMode="decimal" value={amount} onChange={event=>setAmount(event.target.value)} placeholder="0.00"/></div>
    <div className="field"><label className="label" htmlFor="charge-date">Actual charge date</label><input id="charge-date" type="date" className="input" max={today} value={date} onChange={event=>{setDate(event.target.value);setCategory('');}}/></div>
   </div>
   <div className="field"><label className="label" htmlFor="charge-category">Budget category</label><select id="charge-category" className="input" value={category} onChange={event=>setCategory(event.target.value)}><option value="">Uncategorized</option>{categories.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
    <span className="hint">{budget?`Categories from your ${monthName(date)} Budget.`:`No ${date&&isValidCalendarDate(date)?monthName(date):'matching'} Budget exists yet. Logging creates that month with income 0 and no categories; you can view it in Budget.`}</span></div>
   <p className="hint">The transaction description is saved as “{subscription.name}” so it remains a snapshot even if you rename the subscription later.</p>
   {error&&<div className="banner neg">{error}</div>}
  </form>}
 </Modal>;
}
