import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const read = (name: string) => fs.readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const v1 = read("20261003_personal_finance.sql");
const v2 = read("20261004_finance_ledger.sql");
const v3 = read("20261005_finance_planning.sql");

async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table public.profiles(id uuid primary key,default_currency text);grant usage on schema public,auth to authenticated,anon;`);
  await db.exec(v1);
  await db.query(`insert into auth.users values($1),($2)`, [A, B]);
  await db.query(`insert into profiles values($1,'USD'),($2,'USD')`, [A, B]);
  await db.exec(v2);
  await db.exec(v3);
  await db.exec(v3); // idempotent
  return db;
}

async function as(db: PGlite, user: string) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user]);
  await db.exec("set role authenticated");
}

test("planning RPCs validate debt plans, paychecks, pay schedules and credit scores per owner", async () => {
  const db = await setup();
  try {
    let actor = A;
    const rpc = async (fn: string, p: unknown) => (await db.query<{ id: string }>(`select public.${fn}($1::jsonb,$2::uuid,'USD')::text id`, [JSON.stringify(p), actor])).rows[0].id;
    const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

    await as(db, A);
    const card = await rpc("save_finance_account", { name: "Card", type: "credit", balance_cents: 250000, apr_bps: 2499, minimum_cents: 5000, in_payoff: true });
    const loan = await rpc("save_finance_account", { name: "Loan", type: "loan", balance_cents: 900000, apr_bps: 650, minimum_cents: 20000, in_payoff: true });
    const checking = await rpc("save_finance_account", { name: "Checking", type: "checking", balance_cents: 1000 });
    const subscription = await rpc("save_personal_subscription", { name: "Music", amount_cents: 1099, cycle: "monthly", anchor_date: "2020-01-15", status: "active", notes: "" });
    const groceries = (await one<{ id: string }>(`select id from finance_categories where name='Groceries'`)).id;

    // pay schedule
    await rpc("save_finance_pay_schedule", { pay_cycle: "biweekly", pay_anchor: "2020-01-03", paycheck_cents: 285789 });
    assert.deepEqual(await one(`select pay_cycle,pay_anchor::text,pay_day2,paycheck_cents::text from finance_settings`), { pay_cycle: "biweekly", pay_anchor: "2020-01-03", pay_day2: null, paycheck_cents: "285789" });
    await assert.rejects(rpc("save_finance_pay_schedule", { pay_cycle: "semimonthly", pay_anchor: "2020-01-15", paycheck_cents: 1 }), /second payday/);
    await assert.rejects(rpc("save_finance_pay_schedule", { pay_cycle: "semimonthly", pay_anchor: "2020-01-15", pay_day2: 15, paycheck_cents: 1 }), /different days/);
    await assert.rejects(rpc("save_finance_pay_schedule", { pay_cycle: "daily", pay_anchor: "2020-01-15", paycheck_cents: 1 }), /how often/);
    await rpc("save_finance_pay_schedule", { pay_cycle: "semimonthly", pay_anchor: "2020-01-15", pay_day2: 31, paycheck_cents: 200000 });
    assert.equal((await one<{ d: number }>(`select pay_day2 d from finance_settings`)).d, 31);

    // debt plan
    const plan = {
      strategy: "custom", extra_monthly_cents: 10000, rollover: true,
      priority: [loan, card],
      payments: [{ account_id: card, monthly_cents: 15000, due_day: 12 }, { account_id: loan, monthly_cents: null, due_day: null }],
      extra_changes: [{ month: "2020-06", extra_monthly_cents: 30000 }, { month: "2020-03", extra_monthly_cents: 20000 }],
      lump_sums: [{ month: "2020-04", account_id: card, amount_cents: 100000, note: "Tax refund" }, { month: "2020-02", account_id: null, amount_cents: 5000 }],
    };
    await rpc("save_finance_debt_plan", plan);
    const saved = await one<{ strategy: string; priority: string[]; payments: unknown[]; extra_changes: { month: string }[]; lump_sums: { month: string; id: string; note: string }[] }>(`select * from finance_debt_plans`);
    assert.equal(saved.strategy, "custom");
    assert.deepEqual(saved.priority, [loan, card]);
    assert.deepEqual(saved.payments, [{ account_id: card, monthly_cents: 15000, due_day: 12 }, { account_id: loan, monthly_cents: null, due_day: null }]);
    assert.deepEqual(saved.extra_changes.map((c) => c.month), ["2020-03", "2020-06"], "changes are sorted by month");
    assert.deepEqual(saved.lump_sums.map((l) => l.month), ["2020-02", "2020-04"]);
    assert.ok(saved.lump_sums.every((l) => /^[0-9a-f-]{36}$/.test(l.id)), "lump sums get ids");
    await rpc("save_finance_debt_plan", { ...plan, strategy: "snowball" });
    assert.equal((await one<{ n: number }>(`select count(*)::int n from finance_debt_plans`)).n, 1, "one plan per person");
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, priority: [checking] }), /Debt not found/);
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, priority: [card, card] }), /once/);
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, payments: [{ account_id: card, monthly_cents: 0 }] }), /Invalid amount/);
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, payments: [{ account_id: card, monthly_cents: 1, due_day: 32 }] }), /due day/);
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, extra_changes: [{ month: "2020-13", extra_monthly_cents: 1 }] }), /valid month/);
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, extra_changes: [{ month: "2020-03", extra_monthly_cents: 1 }, { month: "2020-03", extra_monthly_cents: 2 }] }), /already have a change/);
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, lump_sums: [{ month: "2020-03", account_id: null, amount_cents: 0 }] }), /Invalid amount/);
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, strategy: "random" }), /strategy/);
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, rollover: "yes" }), /rollover/);

    // paychecks
    const allocations = [
      { label: "Music", kind: "bill", ref_id: subscription, amount_cents: 1099, done: true },
      { label: "Card payment", kind: "debt", ref_id: card, amount_cents: 15000 },
      { label: "Groceries", kind: "spending", ref_id: groceries, amount_cents: 20000 },
      { label: "Emergency fund", kind: "savings", ref_id: null, amount_cents: 50000 },
      { label: "Buffer", kind: "other", ref_id: card, amount_cents: 0 },
    ];
    const pay = await rpc("save_finance_paycheck", { pay_date: "2020-01-15", amount_cents: 200000, allocations, note: "", received: false });
    const row = await one<{ allocations: { kind: string; ref_id: string | null; done: boolean; id: string }[] }>(`select allocations from finance_paychecks where id=$1`, [pay]);
    assert.equal(row.allocations.length, 5);
    assert.equal(row.allocations[0].done, true);
    assert.equal(row.allocations[1].done, false, "done defaults to false");
    assert.equal(row.allocations[4].ref_id, null, "'other' lines never keep a reference");
    await assert.rejects(rpc("save_finance_paycheck", { pay_date: "2020-01-15", amount_cents: 1, allocations: [], note: "", received: false }), /already have a paycheck/);
    await assert.rejects(rpc("save_finance_paycheck", { pay_date: "2020-01-31", amount_cents: 0, allocations: [], note: "", received: false }), /Invalid amount/);
    await assert.rejects(rpc("save_finance_paycheck", { pay_date: "2020-01-31", amount_cents: 1, allocations: [{ label: "x", kind: "debt", ref_id: checking, amount_cents: 1 }], note: "", received: false }), /Debt not found/);
    await assert.rejects(rpc("save_finance_paycheck", { pay_date: "2020-01-31", amount_cents: 1, allocations: [{ label: "", kind: "other", amount_cents: 1 }], note: "", received: false }), /label/);
    await assert.rejects(rpc("save_finance_paycheck", { pay_date: "2020-01-31", amount_cents: 1, allocations: [{ label: "x", kind: "rent", amount_cents: 1 }], note: "", received: false }), /line type/);
    await rpc("save_finance_paycheck", { id: pay, pay_date: "2020-01-15", amount_cents: 210000, allocations, note: "Raise", received: true });
    assert.deepEqual(await one(`select amount_cents::text a,received,note from finance_paychecks where id=$1`, [pay]), { a: "210000", received: true, note: "Raise" });

    // credit scores
    const ex = await rpc("save_finance_credit_score", { bureau: "experian", score: 712, model: "FICO 8", as_of: "2020-01-10", source: "Experian app", note: "" });
    await rpc("save_finance_credit_score", { bureau: "equifax", score: 705, model: "VantageScore 3.0", as_of: "2020-01-10", source: "", note: "" });
    await rpc("save_finance_credit_score", { bureau: "transunion", score: 698, model: "", as_of: "2020-01-10", source: "", note: "" });
    await assert.rejects(rpc("save_finance_credit_score", { bureau: "experian", score: 715, model: "fico 8", as_of: "2020-01-10", source: "", note: "" }), /already logged/);
    await rpc("save_finance_credit_score", { bureau: "experian", score: 715, model: "VantageScore 3.0", as_of: "2020-01-10", source: "", note: "" });
    await assert.rejects(rpc("save_finance_credit_score", { bureau: "fico", score: 700, as_of: "2020-01-10" }), /Equifax/);
    await assert.rejects(rpc("save_finance_credit_score", { bureau: "experian", score: 901, as_of: "2020-01-11" }), /250 to 900/);
    await assert.rejects(rpc("save_finance_credit_score", { bureau: "experian", score: 700.5, as_of: "2020-01-11" }), /250 to 900/);
    await assert.rejects(rpc("save_finance_credit_score", { bureau: "experian", score: "700", as_of: "2020-01-11" }), /250 to 900/);
    await assert.rejects(rpc("save_finance_credit_score", { bureau: "experian", score: 700, as_of: "2199-01-01" }), /hasn't happened/);
    await rpc("save_finance_credit_score", { id: ex, bureau: "experian", score: 720, model: "FICO 8", as_of: "2020-01-10", source: "Experian app", note: "Corrected" });
    assert.equal((await one<{ s: number }>(`select score s from finance_credit_scores where id=$1`, [ex])).s, 720);
    assert.equal((await one<{ n: number }>(`select count(*)::int n from finance_credit_scores`)).n, 4);

    // currency lock covers paychecks and the pay schedule
    await assert.rejects(db.query(`select save_finance_settings('EUR',$1)`, [actor]), /locked/);

    // another person cannot see or touch any of it
    await as(db, B);
    actor = B;
    for (const t of ["finance_debt_plans", "finance_paychecks", "finance_credit_scores"]) {
      assert.equal((await one<{ n: number }>(`select count(*)::int n from ${t}`)).n, 0, `${t} is owner-only`);
    }
    await assert.rejects(rpc("save_finance_debt_plan", { ...plan, payments: [], lump_sums: [], extra_changes: [], priority: [card] }), /Debt not found/);
    await assert.rejects(rpc("save_finance_paycheck", { id: pay, pay_date: "2020-01-15", amount_cents: 1, allocations: [], note: "", received: false }), /not found/);
    await assert.rejects(db.query(`select delete_finance_credit_score($1,$2,'USD')`, [ex, B]), /not found/);
    await assert.rejects(db.query(`select delete_finance_paycheck($1,$2,'USD')`, [pay, B]), /not found/);
    await assert.rejects(db.query(`insert into finance_credit_scores(user_id,bureau,score,as_of) values($1,'experian',800,'2020-01-01')`, [B]), /permission denied/);
    await assert.rejects(db.query(`select save_finance_paycheck('{}'::jsonb,$1,'USD')`, [A]), /account changed/);

    // owner deletes
    await as(db, A);
    actor = A;
    await db.query(`select delete_finance_credit_score($1,$2,'USD')`, [ex, A]);
    await db.query(`select delete_finance_paycheck($1,$2,'USD')`, [pay, A]);
    assert.equal((await one<{ n: number }>(`select count(*)::int n from finance_paychecks`)).n, 0);
    await rpc("save_finance_pay_schedule", { pay_cycle: null });
    assert.deepEqual(await one(`select pay_cycle,paycheck_cents::text p from finance_settings`), { pay_cycle: null, p: "0" });
  } finally {
    await db.close();
  }
});
