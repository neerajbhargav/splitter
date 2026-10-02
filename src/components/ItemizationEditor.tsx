"use client";
import { Plus, Trash2 } from "lucide-react";
import type { Member } from "@/lib/types";
import { money } from "@/lib/format";
export type ItemDraft = { description:string; amount:string; member_ids:string[] };
export function ItemizationEditor({items,onChange,tax,tip,onTax,onTip,members,currency,total,problem}:{
 items:ItemDraft[];onChange:(items:ItemDraft[])=>void;tax:string;tip:string;onTax:(v:string)=>void;onTip:(v:string)=>void;
 members:Member[];currency:string;total:number;problem:string|null;
}){
 const patch=(i:number,value:Partial<ItemDraft>)=>onChange(items.map((it,k)=>k===i?{...it,...value}:it));
 return <div className="stack itemization-editor">
  <p className="hint">Enter line totals in {currency}. Assign each item to one or more people. Shared items are divided evenly; tax and tip follow each person&apos;s subtotal.</p>
  {items.map((it,i)=><div className="card stack" key={i} style={{padding:14,gap:12}}>
   <div className="item-inputs">
    <div className="field"><label className="label" htmlFor={`item-name-${i}`}>Item {i+1}</label><input id={`item-name-${i}`} className="input" value={it.description} maxLength={100} placeholder="Pizza, coffee..." onChange={e=>patch(i,{description:e.target.value})}/></div>
    <div className="field"><label className="label" htmlFor={`item-amount-${i}`}>Line total</label><input id={`item-amount-${i}`} className="input num" inputMode="decimal" value={it.amount} placeholder="0.00" onChange={e=>patch(i,{amount:e.target.value})}/></div>
    <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove item ${i+1}`} onClick={()=>onChange(items.filter((_,k)=>k!==i))}><Trash2/></button>
   </div>
   <fieldset className="item-assignees"><legend className="hint">Who shares this item?</legend><div className="row-flex wrap">
    {members.map(m=><label className={`badge ${it.member_ids.includes(m.id)?'gold':''}`} key={m.id}><input type="checkbox" checked={it.member_ids.includes(m.id)} onChange={()=>patch(i,{member_ids:it.member_ids.includes(m.id)?it.member_ids.filter(id=>id!==m.id):[...it.member_ids,m.id]})}/>{m.display_name}</label>)}
   </div></fieldset>
  </div>)}
  <button type="button" className="btn" disabled={items.length>=100} onClick={()=>onChange([...items,{description:"",amount:"",member_ids:[]}])}><Plus/>Add item</button>
  <div className="form-row"><div className="field"><label className="label" htmlFor="items-tax">Tax amount</label><input id="items-tax" className="input num" inputMode="decimal" value={tax} onChange={e=>onTax(e.target.value)} placeholder="0.00"/></div><div className="field"><label className="label" htmlFor="items-tip">Tip amount</label><input id="items-tip" className="input num" inputMode="decimal" value={tip} onChange={e=>onTip(e.target.value)} placeholder="0.00"/></div></div>
  <div className="between"><span className={problem?'neg':'muted'}>{problem??'Items, tax and tip add up'}</span><b className="num">{money(total,currency)}</b></div>
 </div>;
}
