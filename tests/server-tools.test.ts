import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { itemizedSplit } from "../src/lib/itemization.ts";
import { convertItemizedBill } from "../src/lib/itemized-currency.ts";

test("free expense tools persist securely and match client cents",async()=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon nologin;create role authenticated nologin;
 create schema auth;create table auth.users(id uuid primary key default gen_random_uuid(),email text,raw_user_meta_data jsonb default '{}'::jsonb);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid);
 alter table storage.objects enable row level security;
 create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
 grant usage on schema public,auth,storage to anon,authenticated;grant all on all tables in schema storage to authenticated;`);
 const schema=fs.readFileSync(new URL('../supabase/schema.sql',import.meta.url),'utf8');
 await db.exec(schema);await db.exec(schema);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261001_free_expense_tools.sql',import.meta.url),'utf8'));
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261002_itemized_currency.sql',import.meta.url),'utf8'));
 const u='11111111-1111-4111-8111-111111111111',outsider='22222222-2222-4222-8222-222222222222';
 await db.query(`insert into auth.users(id,email,raw_user_meta_data) values ($1,'test@example.invalid','{"name":"Test"}'),($2,'outside@example.invalid','{"name":"Outside"}')`,[u,outsider]);
 await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[u]);
 const gr=await db.query<{gid:string}>(`select public.create_group('Regression','other','USD','[{"name":"Other"}]') gid`);const gid=gr.rows[0].gid;
 const ms=(await db.query<{id:string}>(`select id from group_members where group_id=$1 order by id`,[gid])).rows.map(m=>m.id);
 for(let i=0;i<30;i++){
  const items=[{description:'A',amount_cents:101+i*37,member_ids:[...ms].reverse()},{description:'B',amount_cents:200+i*11,member_ids:[ms[0]]}];
  const r=itemizedSplit(items,7+i,9+i,ms);assert.equal(r.problem,null);
  const sql=(await db.query<{v:{member_id:string;amount_cents:number}[]}>(`select public.itemized_splits($1,$2::jsonb,$3,$4) v`,[gid,JSON.stringify(items),7+i,9+i])).rows[0].v;
  assert.deepEqual(sql.map(p=>[p.member_id,p.amount_cents]),[...r.out].sort(([a],[b])=>a.localeCompare(b)).map(([id,p])=>[id,p.amount]));
 }
 const items=[{description:'Food',amount_cents:1000,member_ids:[ms[0]]},{description:'Drink',amount_cents:2000,member_ids:[ms[1]]}];
 const input={description:'Dinner',amount_cents:3900,split_type:'equal',items,tax_cents:300,tip_cents:600,payers:[{member_id:ms[0],amount_cents:3900}],splits:[{member_id:ms[0],amount_cents:3900}]};
 const eid=(await db.query<{id:string}>(`select public.save_expense(null,$1,$2::jsonb) id`,[gid,JSON.stringify(input)])).rows[0].id;
 const saved=(await db.query<{items:unknown;split_type:string}>(`select items,split_type from expenses where id=$1`,[eid])).rows[0];assert.deepEqual(saved.items,items);assert.equal(saved.split_type,'exact');
 const splits=(await db.query<{amount_cents:number}>(`select amount_cents::int from expense_splits where expense_id=$1 order by amount_cents`,[eid])).rows;assert.deepEqual(splits.map(s=>s.amount_cents),[1300,2600]);
 await assert.rejects(db.query(`select public.save_expense(null,$1,$2::jsonb)`,[gid,JSON.stringify({...input,amount_cents:1,payers:[{member_id:ms[0],amount_cents:1}]})]),/match the total/);
 await assert.rejects(db.query(`select public.itemized_splits($1,$2::jsonb,0,0)`,[gid,JSON.stringify([{description:'X',amount_cents:10,member_ids:[outsider]}])]),/belong/);
 const def={type:'percent',members:ms.map((member_id,i)=>({member_id,weight:i?60:40}))};
 await db.query(`select public.save_default_split($1,$2::jsonb)`,[gid,JSON.stringify(def)]);
 assert.deepEqual((await db.query<{default_split:unknown}>(`select default_split from groups where id=$1`,[gid])).rows[0].default_split,def);
 await assert.rejects(db.query(`select public.save_default_split($1,$2::jsonb)`,[gid,JSON.stringify({...def,members:ms.map(member_id=>({member_id,weight:30}))})]),/100/);
 await db.query(`select public.save_default_split($1,null)`,[gid]);
 const foreign={description:'Foreign',amount_cents:1250,payers:[{member_id:ms[0],amount_cents:1250}],splits:[{member_id:ms[1],amount_cents:1250}],source_currency:'EUR',source_amount_cents:1000,fx_rate:1.25,fx_date:'2026-01-01'};
 const fxid=(await db.query<{id:string}>(`select public.save_expense(null,$1,$2::jsonb) id`,[gid,JSON.stringify(foreign)])).rows[0].id;
 assert.equal((await db.query<{source_currency:string}>(`select source_currency from expenses where id=$1`,[fxid])).rows[0].source_currency,'EUR');
 await assert.rejects(db.query(`select public.save_expense(null,$1,$2::jsonb)`,[gid,JSON.stringify({...foreign,fx_rate:2})]),/Invalid currency conversion/);
 await assert.rejects(db.query(`select public.update_group($1,null,null,'EUR',null)`,[gid]),/base currency/);
 // Converted original lines are persisted and independently checked by PostgreSQL.
 const converted=convertItemizedBill(items,300,600,1.1355);
 const sqlConverted=(await db.query<{v:unknown}>(`select public.convert_itemized_bill($1,$2::jsonb,300,600,$3) v`,[gid,JSON.stringify(items),converted.total])).rows[0].v;
 assert.deepEqual(sqlConverted,{items:converted.items,tax_cents:converted.tax_cents,tip_cents:converted.tip_cents});
 const hugeSource=[{description:'A',amount_cents:4503599627320495,member_ids:[ms[0]]},{description:'B',amount_cents:4503599627320496,member_ids:[ms[1]]}];
 const huge=convertItemizedBill(hugeSource,0,0,1.0000000000001);
 const hugeSql=(await db.query<{v:unknown}>(`select public.convert_itemized_bill($1,$2::jsonb,0,0,$3) v`,[gid,JSON.stringify(hugeSource),huge.total])).rows[0].v;
 assert.deepEqual(hugeSql,{items:huge.items,tax_cents:0,tip_cents:0});
 const foreignItems={description:'Foreign itemized',amount_cents:converted.total,items:converted.items,tax_cents:converted.tax_cents,tip_cents:converted.tip_cents,source_items:items,source_tax_cents:300,source_tip_cents:600,source_currency:'EUR',source_amount_cents:3900,fx_rate:1.1355,fx_date:'2026-01-01',payers:[{member_id:ms[0],amount_cents:converted.total}],splits:[]};
 const foreignItemsId=(await db.query<{id:string}>(`select public.save_expense(null,$1,$2::jsonb) id`,[gid,JSON.stringify(foreignItems)])).rows[0].id;
 assert.deepEqual((await db.query<{source_items:unknown}>(`select source_items from expenses where id=$1`,[foreignItemsId])).rows[0].source_items,items);
 const wrongLines=converted.items.map((it,i)=>({...it,amount_cents:it.amount_cents+(i===0?1:-1)}));
 await assert.rejects(db.query(`select public.save_expense(null,$1,$2::jsonb)`,[gid,JSON.stringify({...foreignItems,items:wrongLines})]),/do not match/);
 await assert.rejects(db.query(`select public.save_expense(null,$1,$2::jsonb)`,[gid,JSON.stringify({...foreignItems,source_tip_cents:1})]),/source and converted total/);
 // A zero-cent assignee is still part of the historical item, even with no split row.
 const zero='ffffffff-ffff-4fff-8fff-ffffffffffff';
 await db.query(`insert into group_members(id,group_id,display_name) values($1,$2,'Zero share')`,[zero,gid]);
 const tiny={description:'Tiny',amount_cents:1,items:[{description:'Shared penny',amount_cents:1,member_ids:[ms[0],zero]}],payers:[{member_id:ms[0],amount_cents:1}],splits:[]};
 await db.query(`select public.save_expense(null,$1,$2::jsonb)`,[gid,JSON.stringify(tiny)]);
 await db.query(`select public.remove_member($1)`,[zero]);
 assert.equal((await db.query<{is_active:boolean}>(`select is_active from group_members where id=$1`,[zero])).rows[0].is_active,false);
 // Recurring copies retain the fixed conversion snapshot, not a silently refreshed rate.
 const recurring=(await db.query<{id:string}>(`select public.save_expense(null,$1,$2::jsonb) id`,[gid,JSON.stringify({...foreign,description:'Repeat foreign',repeat_interval:'monthly'})])).rows[0].id;
 await db.query(`update expenses set next_repeat_on=current_date where id=$1`,[recurring]);
 await db.query(`select public.process_recurring()`);
 const copied=(await db.query<{fx_rate:string;source_currency:string}>(`select fx_rate,source_currency from expenses where description='Repeat foreign' and id<>$1`,[recurring])).rows[0];
 assert.equal(Number(copied.fx_rate),1.25);assert.equal(copied.source_currency,'EUR');
 await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[outsider]);
 await assert.rejects(db.query(`select public.save_default_split($1,$2::jsonb)`,[gid,JSON.stringify(def)]),/not in this group/);
 await assert.rejects(db.query(`select public.save_expense(null,$1,$2::jsonb)`,[gid,JSON.stringify(input)]),/not in this group/);
 const grant=(await db.query<{allowed:boolean}>(`select has_function_privilege('anon','public.save_default_split(uuid,jsonb)','EXECUTE') allowed`)).rows[0];assert.equal(grant.allowed,false);
 } finally {await db.close();}
});
