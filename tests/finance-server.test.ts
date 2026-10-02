import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {PGlite} from '@electric-sql/pglite';
test('private finance CRUD enforces ownership, cents, categories and duplicate-charge rules',async()=>{
 const db=new PGlite();
 const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',cat='33333333-3333-4333-8333-333333333333';
 try{
 await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create table public.profiles(id uuid primary key,default_currency text);grant usage on schema public,auth to authenticated,anon;`);
 const schema=fs.readFileSync(new URL('../supabase/migrations/20261003_personal_finance.sql',import.meta.url),'utf8');await db.exec(schema);await db.exec(schema);
 await db.query(`insert into auth.users values($1),($2);`,[a,b]);await db.query(`insert into profiles values($1,'USD'),($2,'EUR')`,[a,b]);
 await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[a]);await db.exec('set role authenticated');
 let actor=a,currency='USD';
 const rpc=async(fn:string,p:unknown)=>(await db.query<{id:string}>(`select public.${fn}($1::jsonb,$2::uuid,$3::text) id`,[JSON.stringify(p),actor,currency])).rows[0].id;
 await db.query(`select public.save_finance_settings('USD',$1)`,[actor]);
 const debt=await rpc('save_personal_debt',{name:'Loan',balance_cents:100000,apr_bps:1899,minimum_cents:5000});
 assert.equal((await db.query<{balance_cents:number}>(`select balance_cents::int from personal_debts where id=$1`,[debt])).rows[0].balance_cents,100000);
 await rpc('save_personal_debt',{id:debt,name:'Loan updated',balance_cents:90000,apr_bps:0,minimum_cents:5000});
 await assert.rejects(rpc('save_personal_debt',{name:'Bad',balance_cents:1.5,apr_bps:0,minimum_cents:1}),/Invalid amount/);
 await assert.rejects(rpc('save_personal_debt',{name:'Bad',balance_cents:10,apr_bps:1.1,minimum_cents:1}),/APR/);
 await assert.rejects(rpc('save_personal_debt',{name:'Bad',balance_cents:10,apr_bps:0,minimum_cents:0}),/Invalid amount/);
 await assert.rejects(db.query(`select public.save_finance_settings('EUR',$1)`,[actor]),/locked/);
 const category={id:cat,name:'Groceries',kind:'needs',limit_cents:40000};
 await rpc('save_budget_month',{month:'2020-01-01',income_cents:300000,categories:[category]});
 const entry=await rpc('save_budget_transaction',{description:'Food',amount_cents:4500,expense_date:'2020-01-05',category_id:cat});
 await assert.rejects(rpc('save_budget_month',{month:'2020-01-01',income_cents:300000,categories:[]}),/logged entries/);
 await assert.rejects(rpc('save_budget_month',{month:'2020-01-01',income_cents:300000,categories:[category,category]}),/duplicate/);
 await assert.rejects(rpc('save_budget_transaction',{description:'Bad',amount_cents:1,expense_date:'2020-02-05',category_id:cat}),/category/);
 await assert.rejects(rpc('save_budget_transaction',{description:'Future',amount_cents:1,expense_date:'2199-02-05'}),/future/);
 await assert.rejects(rpc('save_budget_transaction',{description:'Bad',amount_cents:1000000000001,expense_date:'2020-01-05'}),/Invalid amount/);
 const sub=await rpc('save_personal_subscription',{name:'Synthetic music',amount_cents:1000,cycle:'monthly',anchor_date:'2020-01-31',status:'active',notes:''});
 const charge=await rpc('save_budget_transaction',{description:'Music charge',amount_cents:1000,expense_date:'2020-02-01',subscription_id:sub});
 assert.equal((await db.query<{n:number}>(`select count(*)::int n from budget_months where month='2020-02-01'`)).rows[0].n,1);
 await assert.rejects(rpc('save_budget_transaction',{description:'Duplicate',amount_cents:1000,expense_date:'2020-02-01',subscription_id:sub}),/already has a logged charge/);
 await rpc('save_budget_transaction',{id:charge,description:'Music corrected',amount_cents:1200,expense_date:'2020-02-01',subscription_id:sub});
 // Tenant B cannot see, mutate or reference Tenant A records, even if IDs are known.
 await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[b]);actor=b;currency='EUR';
 for(const table of ['finance_settings','personal_debts','budget_months','budget_transactions','personal_subscriptions'])assert.equal((await db.query(`select * from ${table}`)).rows.length,0,table+' isolation');
 await assert.rejects(rpc('save_personal_debt',{id:debt,name:'Stolen',balance_cents:100,apr_bps:0,minimum_cents:1}),/not found/);
 await assert.rejects(db.query(`select delete_personal_debt($1,$2,$3)`,[debt,actor,currency]),/not found/);
 await assert.rejects(rpc('save_budget_transaction',{id:entry,description:'Stolen',amount_cents:1,expense_date:'2020-01-05'}),/not found/);
 await assert.rejects(rpc('save_budget_transaction',{description:'Stolen link',amount_cents:1,expense_date:'2020-01-05',subscription_id:sub}),/not found/);
 await assert.rejects(rpc('save_personal_subscription',{id:sub,name:'Stolen',amount_cents:1,cycle:'monthly',anchor_date:'2020-01-01',status:'active',notes:''}),/not found/);
 await assert.rejects(db.query(`insert into personal_debts(user_id,name,balance_cents,apr_bps,minimum_cents) values($1,'Raw write',1,0,1)`,[b]),/permission denied/);
 await assert.rejects(db.query(`select _finance_owner_lock($1,'EUR',false)`,[actor]),/permission denied/);
 // Profile currency fallback and stale account/currency guards are enforced server-side.
 await db.exec('reset role');await db.query(`update profiles set default_currency='US' where id=$1`,[b]);await db.exec('set role authenticated');
 await db.query(`select save_finance_settings('USD',$1)`,[b]);await db.query(`select save_finance_settings('EUR',$1)`,[b]);
 await assert.rejects(db.query(`select save_personal_debt($1::jsonb,$2,'USD')`,[JSON.stringify({name:'Stale draft',balance_cents:10,apr_bps:0,minimum_cents:1}),b]),/currency changed/);
 await assert.rejects(db.query(`select save_personal_debt($1::jsonb,$2,'USD')`,[JSON.stringify({name:'Wrong account draft',balance_cents:10,apr_bps:0,minimum_cents:1}),a]),/account changed/);
 await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[a]);actor=a;currency='USD';
 // Existing entries cannot be moved into a destination month already at its limit.
 await db.exec('reset role');
 await db.query(`insert into budget_transactions(user_id,description,amount_cents,expense_date) select $1,'Limit fixture',1,'2020-03-01'::date from generate_series(1,5000)`,[a]);
 await db.exec('set role authenticated');
 await assert.rejects(rpc('save_budget_transaction',{id:entry,description:'Move',amount_cents:4500,expense_date:'2020-03-01'}),/5000 entries/);
 await db.query(`select delete_personal_subscription($1,$2,$3)`,[sub,actor,currency]);
 assert.equal((await db.query<{subscription_id:string|null}>(`select subscription_id from budget_transactions where id=$1`,[charge])).rows[0].subscription_id,null,'charge history survives subscription deletion');
 await db.query(`select delete_budget_transaction($1,$2,$3)`,[entry,actor,currency]);await db.query(`select delete_budget_transaction($1,$2,$3)`,[charge,actor,currency]);await db.query(`select delete_personal_debt($1,$2,$3)`,[debt,actor,currency]);
 await rpc('save_budget_month',{month:'2020-01-01',income_cents:0,categories:[]});
 await db.exec('reset role');
 for(const fn of ['save_finance_settings(text,uuid)','save_personal_debt(jsonb,uuid,text)','delete_personal_debt(uuid,uuid,text)','save_budget_month(jsonb,uuid,text)','save_budget_transaction(jsonb,uuid,text)','delete_budget_transaction(uuid,uuid,text)','save_personal_subscription(jsonb,uuid,text)','delete_personal_subscription(uuid,uuid,text)'])assert.equal((await db.query<{v:boolean}>(`select has_function_privilege('anon',$1,'execute') v`,['public.'+fn])).rows[0].v,false,fn);
 await db.query(`select set_config('request.jwt.claim.sub','',false)`);await assert.rejects(db.query(`select save_personal_debt('{"name":"No auth","balance_cents":1,"apr_bps":0,"minimum_cents":1}',null,'USD')`),/Not signed in/);
 }finally{await db.close();}
});
