import { convertCents } from './currency.ts';
import type { ExpenseItem } from './types.ts';

/** Convert the whole bill once, then distribute its exact target cents across lines/tax/tip.
 * Independent line rounding could make the converted bill disagree with its total. */
export function convertItemizedBill(items:ExpenseItem[],tax:number,tip:number,rate:number){
 const values=[...items.map(it=>it.amount_cents),tax,tip];
 if(!items.length || values.some(n=>!Number.isSafeInteger(n)||n<0) || items.some(it=>it.amount_cents<=0)) throw new Error('Enter valid positive item totals and nonnegative tax/tip.');
 const source=values.reduce((n,v)=>n+BigInt(v),0n);
 if(source>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Bill total is too large.');
 const total=convertCents(Number(source),rate);
 const parts=values.map((n,i)=>{const raw=BigInt(total)*BigInt(n);return {i,amount:raw/source,remainder:raw%source};});
 let left=BigInt(total)-parts.reduce((n,p)=>n+p.amount,0n);
 const order=[...parts].sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1);
 for(const part of order){if(left===0n)break;part.amount++;left--;}
 const amounts=parts.map(p=>Number(p.amount));
 if(amounts.slice(0,items.length).some(n=>n<1))throw new Error('Some items convert to less than one ledger cent. Combine those tiny line items before converting.');
 return {items:items.map((it,i)=>({...it,amount_cents:amounts[i]})),tax_cents:amounts[items.length],tip_cents:amounts[items.length+1],total,source_total:Number(source)};
}
