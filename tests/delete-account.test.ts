import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pg-harness.ts";

const A = "11111111-1111-4111-8111-111111111111"; // deletes their account
const B = "22222222-2222-4222-8222-222222222222"; // shares a house with A

for (const migration of [[], ["20261118_delete_account.sql"]]) test(`delete_my_account keeps shared history and removes the rest${migration.length ? " (migration on top)" : ""}`, async () => {
  const { db, as, user } = await freshDb(...migration);
  try {
    await user(A, "a@example.invalid", "Ana");
    await user(B, "b@example.invalid", "Ben");
    const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

    // A shared house that B joins, a trip nobody else joined, and A's own finances.
    await as(A);
    const house = (await one<{ id: string }>(`select public.create_group('House','home','USD','[{"name":"Sam"}]')::text id`)).id;
    const trip = (await one<{ id: string }>(`select public.create_group('Trip','trip','USD','[{"name":"Placeholder pal"}]')::text id`)).id;
    const aSpot = (await one<{ id: string }>(`select id::text id from group_members where group_id=$1 and user_id=$2`, [house, A])).id;
    await db.query(`update group_members set email='a@example.invalid', phone='555-0100' where id=$1`, [aSpot]);
    const code = (await one<{ c: string }>(`select invite_code c from groups where id=$1`, [house])).c;
    await as(B);
    await db.query(`select public.join_group($1,null,true)`, [code]);
    const bSpot = (await one<{ id: string }>(`select id::text id from group_members where group_id=$1 and user_id=$2`, [house, B])).id;
    await as(A);
    await db.query(`select public.save_expense(null,$1,$2::jsonb)`, [house, JSON.stringify({
      description: "Rent", amount_cents: 3000, category: "general", expense_date: "2026-01-05", split_type: "equal",
      payers: [{ member_id: aSpot, amount_cents: 3000 }],
      splits: [{ member_id: aSpot, amount_cents: 1500 }, { member_id: bSpot, amount_cents: 1500 }],
    })]);
    await db.query(`select public.ensure_finance_workspace($1,'USD')`, [A]);
    await db.query(`select public.save_finance_account($1::jsonb,$2::uuid,'USD')`, [JSON.stringify({ name: "Checking", type: "checking", balance_cents: 100 }), A]);
    await db.query(`select public.create_personal_token('calendar')`);

    // Signed out, and as anon, it is refused.
    await as("");
    await assert.rejects(db.query(`select public.delete_my_account()`), /not signed in/i);
    await db.exec("begin; set local role anon;");
    await assert.rejects(db.query(`select public.delete_my_account()`), /permission denied/);
    await db.exec("rollback");

    await as(A);
    const r = (await one<{ r: { groups_deleted: number; spots_kept: number } }>(`select public.delete_my_account() r`)).r;
    assert.deepEqual(r, { groups_deleted: 1, spots_kept: 1 });

    const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(`select count(*)::text n from ${sql}`, params)).n);
    assert.equal(await count(`auth.users where id=$1`, [A]), 0);
    assert.equal(await count(`profiles where id=$1`, [A]), 0);
    assert.equal(await count(`finance_accounts where user_id=$1`, [A]), 0);
    assert.equal(await count(`finance_settings where user_id=$1`, [A]), 0);
    assert.equal(await count(`personal_tokens where user_id=$1`, [A]), 0);
    assert.equal(await count(`groups where id=$1`, [trip]), 0, "the trip nobody else joined goes");
    assert.equal(await count(`group_members where group_id=$1`, [trip]), 0);

    // The house stays for B: A's spot is unclaimed, keeps its name and drops its contact details.
    const spot = await one<{ user_id: string | null; display_name: string; email: string | null; phone: string | null }>(
      `select user_id::text, display_name, email, phone from group_members where id=$1`, [aSpot]);
    assert.deepEqual(spot, { user_id: null, display_name: "Ana", email: null, phone: null });
    assert.equal(await count(`expenses where group_id=$1`, [house]), 1);
    assert.equal(await count(`group_members where group_id=$1 and user_id=$2`, [house, B]), 1);
    assert.equal(await count(`auth.users where id=$1`, [B]), 1);

    // B can still read the house and its balances, and can now delete it (no owner is left).
    await as(B);
    await db.exec("begin; set local role authenticated;");
    await db.query(`select set_config('request.jwt.claim.sub',$1,true)`, [B]);
    assert.equal(await count(`expenses where group_id=$1`, [house]), 1, "B still reads the house under row level security");
    await db.exec("rollback");
    await db.query(`select public.delete_group($1)`, [house]);
    assert.equal(await count(`groups where id=$1`, [house]), 0);
  } finally {
    await db.close();
  }
});
