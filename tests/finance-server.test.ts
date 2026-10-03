import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OLD_CAT = "33333333-3333-4333-8333-333333333333";
const OLD_CAT_DUP = "44444444-4444-4444-8444-444444444444";
const OLD_DEBT = "55555555-5555-4555-8555-555555555555";
const OLD_SUB = "66666666-6666-4666-8666-666666666666";
const OLD_TX = "77777777-7777-4777-8777-777777777777";

const v1 = fs.readFileSync(new URL("../supabase/migrations/20261003_personal_finance.sql", import.meta.url), "utf8");
const v2 = fs.readFileSync(new URL("../supabase/migrations/20261004_finance_ledger.sql", import.meta.url), "utf8");

async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table public.profiles(id uuid primary key,default_currency text);grant usage on schema public,auth to authenticated,anon;`);
  await db.exec(v1);
  await db.query(`insert into auth.users values($1),($2)`, [A, B]);
  await db.query(`insert into profiles values($1,'USD'),($2,'EUR')`, [A, B]);
  return db;
}

async function as(db: PGlite, user: string | null) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec("set role authenticated");
}

test("v1 finance data migrates into the unified ledger without loss", async () => {
  const db = await setup();
  try {
    await db.query(`insert into finance_settings(user_id,currency) values($1,'USD')`, [A]);
    await db.query(`insert into personal_debts(id,user_id,name,balance_cents,apr_bps,minimum_cents) values($1,$2,'Student loan',1234567,499,15000),('99999999-9999-4999-8999-999999999999',$2,'CREDIT CARDS',560000,0,560000)`, [OLD_DEBT, A]);
    await db.query(`insert into personal_subscriptions(id,user_id,name,amount_cents,cycle,anchor_date) values($1,$2,'Music',1099,'monthly','2020-01-15')`, [OLD_SUB, A]);
    await db.query(`insert into budget_months(user_id,month,income_cents,categories) values
      ($1,'2020-01-01',300000,$2::jsonb),($1,'2020-02-01',310000,$3::jsonb),($1,'2020-03-01',320000,'[]'::jsonb)`, [A,
      JSON.stringify([{ id: OLD_CAT, name: "Groceries", kind: "wants", limit_cents: 40000 }]),
      JSON.stringify([{ id: OLD_CAT_DUP, name: "groceries", kind: "needs", limit_cents: 45000 }, { id: "88888888-8888-4888-8888-888888888888", name: "Pet costs", kind: "needs", limit_cents: 5000 }])]);
    await db.query(`insert into budget_transactions(id,user_id,description,amount_cents,expense_date,category_id,subscription_id) values($1,$2,'Market run',4521,'2020-01-05',$3,null),(gen_random_uuid(),$2,'Music charge',1099,'2020-01-15',null,$4)`, [OLD_TX, A, OLD_CAT, OLD_SUB]);

    await db.exec(v2);
    await db.exec(v2); // idempotent

    for (const gone of ["personal_debts", "budget_transactions"]) {
      assert.equal((await db.query<{ t: string | null }>(`select to_regclass($1)::text t`, [`public.${gone}`])).rows[0].t, null, `${gone} dropped`);
    }
    const account = (await db.query(`select type,balance_cents::text,apr_bps,minimum_cents::text,in_payoff from finance_accounts where id=$1`, [OLD_DEBT])).rows[0];
    assert.deepEqual(account, { type: "loan", balance_cents: "1234567", apr_bps: 499, minimum_cents: "15000", in_payoff: true });
    assert.equal((await db.query<{ type: string }>(`select type from finance_accounts where name='CREDIT CARDS'`)).rows[0].type, "credit", "\"car\" inside CARDS is not a car loan");

    const cats = (await db.query<{ id: string; name: string; kind: string }>(`select id,name,kind from finance_categories where user_id=$1 order by sort,name`, [A])).rows;
    assert.equal(cats.filter((c) => c.name.toLowerCase() === "groceries").length, 1, "same-name categories merge");
    assert.ok(cats.some((c) => c.name === "Pet costs"), "custom category kept");
    assert.equal(cats.length, 15, "Folio defaults seeded plus the custom category");
    const groceries = cats.find((c) => c.name.toLowerCase() === "groceries")!;
    const limitsFor = async (month: string) => (await db.query<{ limits: { category_id: string; limit_cents: number }[]; income_cents: string }>(`select limits,income_cents::text from budget_months where user_id=$1 and month=$2`, [A, month])).rows[0];
    assert.deepEqual((await limitsFor("2020-01-01")).limits, [{ category_id: groceries.id, limit_cents: 40000 }]);
    assert.equal((await limitsFor("2020-02-01")).limits.length, 2);
    assert.deepEqual(await limitsFor("2020-03-01"), { limits: [], income_cents: "320000" }, "income-only month keeps its income");

    const txs = (await db.query<{ id: string; date: string; amount_cents: string; kind: string; category_id: string | null; subscription_id: string | null; source: string }>(`select id,date::text,amount_cents::text,kind,category_id,subscription_id,source from finance_transactions where user_id=$1 order by date`, [A])).rows;
    assert.equal(txs.length, 2);
    assert.deepEqual(txs[0], { id: OLD_TX, date: "2020-01-05", amount_cents: "4521", kind: "expense", category_id: groceries.id, subscription_id: null, source: "manual" });
    assert.equal(txs[1].subscription_id, OLD_SUB);
    assert.equal(txs[1].source, "subscription");
    assert.equal((await db.query(`select 1 from information_schema.columns where table_name='budget_months' and column_name='categories'`)).rows.length, 0);
  } finally {
    await db.close();
  }
});

test("unified finance RPCs enforce ownership, validation, dedupe and private bank secrets", async () => {
  const db = await setup();
  try {
    await db.exec(v2);
    await db.exec(v2);
    let actor = A;
    let currency = "USD";
    const rpc = async (fn: string, p: unknown) => (await db.query<{ id: string }>(`select public.${fn}($1::jsonb,$2::uuid,$3::text) id`, [JSON.stringify(p), actor, currency])).rows[0].id;
    const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

    await as(db, A);
    await db.query(`select ensure_finance_workspace($1,'USD')`, [A]);
    assert.equal((await one<{ n: number }>(`select count(*)::int n from finance_categories`)).n, 14);
    await db.query(`select ensure_finance_workspace($1,'USD')`, [A]);
    assert.equal((await one<{ n: number }>(`select count(*)::int n from finance_categories`)).n, 14, "seeding happens once");
    const cat = async (name: string) => (await one<{ id: string }>(`select id from finance_categories where name=$1`, [name])).id;
    const groceries = await cat("Groceries");
    const savings = await cat("Savings");

    await db.query(`select save_finance_profile($1::jsonb,$2,$3)`, [JSON.stringify({ monthly_gross_cents: 750000, monthly_net_cents: 540000, housing_cents: 185000, car_cents: 0 }), actor, currency]);
    assert.equal((await one<{ g: string }>(`select monthly_gross_cents::text g from finance_settings`)).g, "750000");
    await assert.rejects(db.query(`select save_finance_profile($1::jsonb,$2,$3)`, [JSON.stringify({ monthly_gross_cents: -1, monthly_net_cents: 0, housing_cents: 0, car_cents: 0 }), actor, currency]), /Invalid amount/);
    await assert.rejects(db.query(`select save_finance_settings('EUR',$1)`, [actor]), /locked/);

    const checking = await rpc("save_finance_account", { name: "Everyday", institution: "Sample Bank", type: "checking", balance_cents: -2500, last4: "0001" });
    const card = await rpc("save_finance_account", { name: "Rewards card", institution: "Sample Bank", type: "credit", balance_cents: 50000, apr_bps: 2499, minimum_cents: 3500, in_payoff: true });
    const brokerage = await rpc("save_finance_account", { name: "Brokerage", institution: "Sample Invest", type: "investment", balance_cents: 0 });
    await assert.rejects(rpc("save_finance_account", { name: "Bad card", type: "credit", balance_cents: -1 }), /positive/);
    await assert.rejects(rpc("save_finance_account", { name: "Bad", type: "checking", balance_cents: 1, last4: "12345" }), /Last 4/);
    await assert.rejects(rpc("save_finance_account", { name: "Bad", type: "credit", balance_cents: 1, apr_bps: "24" }), /APR/);
    await rpc("save_finance_account", { id: checking, name: "Everyday", institution: "Sample Bank", type: "checking", balance_cents: 120000, apr_bps: 1999, minimum_cents: 100 });
    assert.deepEqual(await one(`select apr_bps,minimum_cents from finance_accounts where id=$1`, [checking]), { apr_bps: null, minimum_cents: null }, "assets never keep debt fields");

    const vti = await rpc("save_finance_holding", { account_id: brokerage, symbol: "vti", name: "Total market", shares: "12.5", price_cents: 29000 });
    assert.equal((await one<{ symbol: string }>(`select symbol from finance_holdings where id=$1`, [vti])).symbol, "VTI");
    await assert.rejects(rpc("save_finance_holding", { account_id: checking, symbol: "VTI", shares: "1", price_cents: 1 }), /investment/);
    await assert.rejects(rpc("save_finance_holding", { account_id: brokerage, symbol: "VTI", shares: "1.123456789", price_cents: 1 }), /8 decimals/);
    await assert.rejects(rpc("save_finance_holding", { account_id: brokerage, symbol: "BIG", shares: "1000000000", price_cents: 100000 }), /too large/);
    await assert.rejects(rpc("save_finance_account", { id: brokerage, name: "Brokerage", type: "savings", balance_cents: 0 }), /holdings/);

    await assert.rejects(rpc("save_finance_category", { name: "groceries", kind: "needs" }), /already have/);
    const pets = await rpc("save_finance_category", { name: "Pets", kind: "needs" });

    await rpc("save_budget_month", { month: "2020-01-01", income_cents: 540000, limits: [{ category_id: groceries, limit_cents: 60000 }, { category_id: pets, limit_cents: 5000 }] });
    await assert.rejects(rpc("save_budget_month", { month: "2020-01-01", income_cents: 1, limits: [{ category_id: groceries, limit_cents: 1 }, { category_id: groceries, limit_cents: 2 }] }), /once/);
    await assert.rejects(rpc("save_budget_month", { month: "2020-01-15", income_cents: 1, limits: [] }), /month/);

    const food = await rpc("save_finance_transaction", { date: "2020-01-05", description: "Market run", amount_cents: 4521, kind: "expense", account_id: checking, category_id: groceries });
    const vet = await rpc("save_finance_transaction", { date: "2020-01-06", description: "Vet", amount_cents: 9000, kind: "expense", category_id: pets });
    const pay = await rpc("save_finance_transaction", { date: "2020-01-01", description: "Payroll", amount_cents: 270000, kind: "income", category_id: groceries });
    assert.equal((await one<{ c: string | null }>(`select category_id c from finance_transactions where id=$1`, [pay])).c, null, "income never carries a category");
    await assert.rejects(rpc("save_finance_transaction", { date: "2199-01-01", description: "Future", amount_cents: 1, kind: "expense" }), /happen/);
    await assert.rejects(rpc("save_finance_transaction", { date: "2020-02-30", description: "Bad", amount_cents: 1, kind: "expense" }), /valid date/);
    await assert.rejects(rpc("save_finance_transaction", { date: "2020-01-01", description: "Bad", amount_cents: 0, kind: "expense" }), /Invalid amount/);
    await db.query(`select recategorize_finance_transactions($1::uuid[],$2,$3,$4)`, [[food, pay], savings, actor, currency]);
    assert.equal((await one<{ c: string }>(`select category_id c from finance_transactions where id=$1`, [food])).c, savings);
    assert.equal((await one<{ c: string | null }>(`select category_id c from finance_transactions where id=$1`, [pay])).c, null);

    await db.query(`select delete_finance_category($1,$2,$3,$4)`, [pets, groceries, actor, currency]);
    assert.equal((await one<{ c: string }>(`select category_id c from finance_transactions where id=$1`, [vet])).c, groceries);
    assert.deepEqual((await one<{ limits: unknown }>(`select limits from budget_months where month='2020-01-01'`)).limits, [{ category_id: groceries, limit_cents: 65000 }]);

    const rows = [
      { date: "2020-01-10", description: "Coffee", amount_cents: 450, kind: "expense", category_id: null, external_id: "csv:aaaaaaaaaaaaaaaa" },
      { date: "2020-01-10", description: "Coffee", amount_cents: 450, kind: "expense", category_id: groceries, external_id: "csv:bbbbbbbbbbbbbbbb" },
      { date: "2020-01-11", description: "Card payment", amount_cents: 20000, kind: "transfer", category_id: groceries, external_id: "csv:cccccccccccccccc" },
    ];
    const first = (await one<{ r: { batch: string; inserted: number; skipped: number } }>(`select import_finance_transactions($1,$2::jsonb,$3,$4) r`, [checking, JSON.stringify(rows), actor, currency])).r;
    assert.equal(first.inserted, 3);
    const again = (await one<{ r: { batch: string | null; inserted: number; skipped: number } }>(`select import_finance_transactions($1,$2::jsonb,$3,$4) r`, [checking, JSON.stringify(rows), actor, currency])).r;
    assert.deepEqual([again.inserted, again.skipped, again.batch], [0, 3, null]);
    assert.equal((await one<{ c: string | null }>(`select category_id c from finance_transactions where external_id='csv:cccccccccccccccc'`)).c, null);
    await assert.rejects(db.query(`select import_finance_transactions(null,$1::jsonb,$2,$3)`, [JSON.stringify([{ ...rows[0], external_id: "plaid:x" }]), actor, currency]), /fingerprint/);
    assert.equal((await one<{ n: number }>(`select undo_finance_import($1,$2,$3) n`, [first.batch, actor, currency])).n, 3);

    const sub = await rpc("save_personal_subscription", { name: "Music", amount_cents: 1099, cycle: "monthly", anchor_date: "2020-01-31", status: "active", notes: "", category_id: await cat("Subscriptions"), account_id: card });
    await rpc("save_finance_transaction", { date: "2020-01-31", description: "Music", amount_cents: 1099, kind: "expense", subscription_id: sub });
    await assert.rejects(rpc("save_finance_transaction", { date: "2020-01-31", description: "Music again", amount_cents: 1099, kind: "expense", subscription_id: sub }), /already has a charge/);

    const conn = (await one<{ id: string }>(`select plaid_save_connection('item-1','Sample Bank','v1.ciphertext-placeholder-abcdef',$1,$2) id`, [actor, currency])).id;
    await assert.rejects(db.query(`select * from finance_connection_secrets`), /permission denied/);
    const secret = await one<{ token_ciphertext: string }>(`select * from plaid_connection_secret($1,$2,$3)`, [conn, actor, currency]);
    assert.equal(secret.token_ciphertext, "v1.ciphertext-placeholder-abcdef");
    assert.equal((await one<{ n: number }>(`select plaid_upsert_accounts($1,$2::jsonb,$3,$4) n`, [conn, JSON.stringify([{ account_id: "acc-1", name: "Plaid checking", type: "checking", balance_cents: 50000, mask: "1234" }, { account_id: "acc-2", name: "Plaid card", type: "credit", balance_cents: -7000, mask: "9" }]), actor, currency])).n, 2);
    assert.equal((await one<{ b: string }>(`select balance_cents::text b from finance_accounts where external_id='plaid:acc-2'`)).b, "7000");
    const page = [{ transaction_id: "t1", account_id: "acc-1", date: "2020-01-12", description: "Grocer", amount_cents: 2500, kind: "expense", category: "Groceries", pending: true }];
    await db.query(`select plaid_apply_sync($1,$2::jsonb,'[]'::jsonb,'cursor-1',$3,$4)`, [conn, JSON.stringify(page), actor, currency]);
    const synced = await one<{ id: string; category_id: string; account_id: string }>(`select id,category_id,account_id from finance_transactions where external_id='plaid:t1'`);
    assert.equal(synced.category_id, groceries);
    assert.ok(synced.account_id);
    await db.query(`select recategorize_finance_transactions($1::uuid[],$2,$3,$4)`, [[synced.id], savings, actor, currency]);
    await db.query(`select plaid_apply_sync($1,$2::jsonb,'[]'::jsonb,'cursor-2',$3,$4)`, [conn, JSON.stringify([{ ...page[0], pending: false }]), actor, currency]);
    assert.deepEqual(await one(`select category_id,pending from finance_transactions where external_id='plaid:t1'`), { category_id: savings, pending: false }, "user recategorization survives sync");
    await db.query(`select plaid_apply_sync($1,'[]'::jsonb,'["t1"]'::jsonb,'cursor-3',$2,$3)`, [conn, actor, currency]);
    assert.equal((await one<{ n: number }>(`select count(*)::int n from finance_transactions where external_id='plaid:t1'`)).n, 0);
    assert.equal((await one<{ c: string }>(`select sync_cursor c from plaid_connection_secret($1,$2,$3)`, [conn, actor, currency])).c, "cursor-3");

    await assert.rejects(db.query(`select save_finance_account($1::jsonb,$2,'USD')`, [JSON.stringify({ name: "x", type: "cash", balance_cents: 1 }), B]), /account changed/);
    await assert.rejects(db.query(`select save_finance_account($1::jsonb,$2,'EUR')`, [JSON.stringify({ name: "x", type: "cash", balance_cents: 1 }), A]), /currency changed/);

    await as(db, B);
    actor = B;
    currency = "EUR";
    for (const table of ["finance_settings", "finance_accounts", "finance_holdings", "finance_categories", "budget_months", "finance_transactions", "personal_subscriptions", "finance_connections"]) {
      assert.equal((await db.query(`select * from ${table}`)).rows.length, 0, `${table} isolation`);
    }
    await assert.rejects(rpc("save_finance_account", { id: checking, name: "Stolen", type: "cash", balance_cents: 1 }), /not found/);
    await assert.rejects(db.query(`select delete_finance_account($1,$2,$3)`, [card, actor, currency]), /not found/);
    await assert.rejects(rpc("save_finance_holding", { account_id: brokerage, symbol: "X", shares: "1", price_cents: 1 }), /investment/);
    await assert.rejects(rpc("save_finance_transaction", { date: "2020-01-01", description: "x", amount_cents: 1, kind: "expense", account_id: checking }), /Account not found/);
    await assert.rejects(rpc("save_finance_transaction", { date: "2020-01-01", description: "x", amount_cents: 1, kind: "expense", category_id: groceries }), /Category not found/);
    await assert.rejects(rpc("save_budget_month", { month: "2020-01-01", income_cents: 1, limits: [{ category_id: groceries, limit_cents: 1 }] }), /your categories/);
    assert.equal((await one<{ n: number }>(`select recategorize_finance_transactions($1::uuid[],null,$2,$3) n`, [[food], actor, currency])).n, 0, "cannot recategorize another account's rows");
    await assert.rejects(db.query(`select * from plaid_connection_secret($1,$2,$3)`, [conn, actor, currency]), /not found/);
    await assert.rejects(db.query(`select plaid_apply_sync($1,'[]'::jsonb,'[]'::jsonb,'c',$2,$3)`, [conn, actor, currency]), /not found/);
    await assert.rejects(db.query(`select delete_finance_category($1,null,$2,$3)`, [groceries, actor, currency]), /not found/);
    await assert.rejects(db.query(`select undo_finance_import($1,$2,$3)`, [first.batch, actor, currency]), /already removed/);

    await assert.rejects(db.query(`select _finance_seed_categories($1)`, [B]), /permission denied/);
    await assert.rejects(db.query(`select _finance_owner_lock($1,'EUR',false)`, [B]), /permission denied/);
    await as(db, null);
    await assert.rejects(db.query(`select ensure_finance_workspace($1,'USD')`, [A]), /account changed/);
  } finally {
    await db.close();
  }
});
