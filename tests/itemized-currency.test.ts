import { test } from 'node:test';import assert from 'node:assert/strict';import {convertItemizedBill} from '../src/lib/itemized-currency.ts';
test('foreign items convert once, preserving total and assignments',()=>{
 const items=[{description:'Coffee',amount_cents:1000,member_ids:['a']},{description:'Food',amount_cents:2000,member_ids:['b']}];
 const result=convertItemizedBill(items,300,600,1.1355);
 assert.equal(result.total,4428);assert.equal(result.source_total,3900);assert.equal(result.items.reduce((n,p)=>n+p.amount_cents,0)+result.tax_cents+result.tip_cents,4428);assert.deepEqual(result.items.map(it=>it.member_ids),[['a'],['b']]);assert.deepEqual(items.map(it=>it.amount_cents),[1000,2000]);
});
test('line rounding cannot change the converted bill total',()=>{
 const r=convertItemizedBill([{description:'A',amount_cents:101,member_ids:['a']},{description:'B',amount_cents:101,member_ids:['b']}],0,0,1.005);
 assert.equal(r.total,203);assert.deepEqual(r.items.map(it=>it.amount_cents),[102,101]);
});
test('unsafe, invalid and sub-cent bills are blocked explicitly',()=>{
 assert.throws(()=>convertItemizedBill([{description:'A',amount_cents:1,member_ids:['a']},{description:'B',amount_cents:1000,member_ids:['b']}],0,0,0.001),/tiny/);
 assert.throws(()=>convertItemizedBill([{description:'A',amount_cents:100,member_ids:['a']}],-1,0,1),/valid/);
});
