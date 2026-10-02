import { test } from "node:test";
import assert from "node:assert/strict";
import { itemizedSplit } from "../src/lib/itemization.ts";
test("itemized tax and tip preserve cents and proportions",()=>{
 const r=itemizedSplit([{description:"A",amount_cents:1000,member_ids:["a"]},{description:"B",amount_cents:2000,member_ids:["b"]}],300,600,["a","b"]);
 assert.equal(r.problem,null); assert.equal(r.out.get("a")?.amount,1300);assert.equal(r.out.get("b")?.amount,2600);assert.equal(r.total,3900);
});
test("odd cents deterministic regardless of assignment order",()=>{
 const a=itemizedSplit([{description:"Shared",amount_cents:101,member_ids:["b","a"]}],7,9,["a","b"]);
 const b=itemizedSplit([{description:"Shared",amount_cents:101,member_ids:["a","b"]}],7,9,["a","b"]);
 assert.deepEqual(a,b);assert.equal([...a.out.values()].reduce((n,p)=>n+p.amount,0),117);
});
test("invalid assignments and amounts blocked",()=>{
 for(const item of [{description:"X",amount_cents:10,member_ids:[]},{description:"X",amount_cents:-10,member_ids:["a"]},{description:"X",amount_cents:10,member_ids:["stranger"]},{description:"X",amount_cents:10,member_ids:["a","a"]}])assert.ok(itemizedSplit([item],0,0,["a"]).problem);
});
test("very large item tax allocation stays exact",()=>{
 const values=[64042823825777,21396522417954,92982759669793];const ids=["a","b","c"];
 const r=itemizedSplit(values.map((amount_cents,i)=>({description:ids[i],amount_cents,member_ids:[ids[i]]})),67334177292747,0,ids);
 assert.deepEqual(ids.map(id=>r.out.get(id)?.amount),[88211750830276,29471291105176,128073241270819]);
});
