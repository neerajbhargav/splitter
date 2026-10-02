import { splitEqual } from "./split.ts";
import type { ExpenseItem } from "./types.ts";

/** Items split equally among their assignees. Tax and tip follow each person's subtotal. */
export function itemizedSplit(items: ExpenseItem[], tax: number, tip: number, validIds: string[]) {
  const out = new Map<string, { amount: number; weight: null }>();
  const badMoney = (n: number) => !Number.isSafeInteger(n) || n < 0;
  if (badMoney(tax) || badMoney(tip)) return { out, total: 0, problem: "Tax and tip must be valid nonnegative amounts" };
  if (!items.length || items.length > 100) return { out, total: 0, problem: "Add between 1 and 100 items" };
  const bases = new Map<string, number>();
  for (const item of items) {
    if (!item.description.trim() || item.description.length > 100) return { out, total: 0, problem: "Give each item a name" };
    if (badMoney(item.amount_cents) || item.amount_cents <= 0) return { out, total: 0, problem: "Each item needs a positive amount" };
    const ids = [...item.member_ids].sort();
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !validIds.includes(id))) return { out, total: 0, problem: "Assign each item to people in this group" };
    for (const p of splitEqual(item.amount_cents, ids)) bases.set(p.id, (bases.get(p.id) ?? 0) + p.amount);
  }
  const subtotal = [...bases.values()].reduce((a, n) => a + n, 0);
  const total = subtotal + tax + tip;
  if (!Number.isSafeInteger(total)) return { out, total: 0, problem: "Bill total is too large" };
  const weights = [...bases].sort(([a], [b]) => a.localeCompare(b)).map(([id, weight]) => ({id, weight}));
  // Integer arithmetic agrees with PostgreSQL numeric even near the safe-integer limit.
  const denom=BigInt(subtotal), charge=BigInt(tax)+BigInt(tip);
  const portions=weights.map(w=>{const product=charge*BigInt(w.weight);return {id:w.id,amount:product/denom,remainder:product%denom};});
  const ordered=[...portions].sort((a,b)=>a.remainder===b.remainder?a.id.localeCompare(b.id):a.remainder>b.remainder?-1:1);
  let left=charge-portions.reduce((n,p)=>n+p.amount,0n);
  for(const p of ordered){if(left===0n)break;p.amount++;left--;}
  const extra = new Map(portions.map(p=>[p.id,Number(p.amount)]));
  bases.forEach((n, id) => { if (n + (extra.get(id) ?? 0) > 0) out.set(id, {amount:n + (extra.get(id) ?? 0), weight:null}); });
  return {out, total, problem:null};
}
