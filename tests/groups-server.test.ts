import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

async function freshDb() {
  const db = new PGlite();
  await db.exec(`create role anon nologin;create role authenticated nologin;
    create schema auth;create table auth.users(id uuid primary key default gen_random_uuid(),email text,raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
    grant usage on schema public,auth,storage to anon,authenticated;grant all on all tables in schema storage to authenticated;`);
  await db.exec(read("../supabase/schema.sql"));
  // An existing deployment gets the same result from the migration, and it is safe to re-run.
  await db.exec(read("../supabase/migrations/20261021_group_fixes.sql"));
  await db.exec(read("../supabase/migrations/20261021_group_fixes.sql"));
  const as = (id: string) => db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [id]);
  const user = async (id: string, email: string, name: string) =>
    db.query(`insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3::jsonb)`, [id, email, JSON.stringify({ name })]);
  return { db, as, user };
}

test("stay dates and bill periods persist, and a paid upcoming bill keeps its period", async () => {
  const { db, as } = await freshDb();
  try {
    const u = "11111111-1111-4111-8111-111111111111", outsider = "22222222-2222-4222-8222-222222222222";
    await db.query(`insert into auth.users(id,email,raw_user_meta_data) values ($1,'a@example.invalid','{"name":"A"}'),($2,'o@example.invalid','{"name":"O"}')`, [u, outsider]);
    await as(u);
    const gid = (await db.query<{ gid: string }>(`select public.create_group('House','home','USD','[{"name":"Leaver"}]') gid`)).rows[0].gid;
    const [me, leaver] = (await db.query<{ id: string }>(`select id from group_members where group_id=$1 order by display_name`, [gid])).rows.map((r) => r.id);

    await db.query(`select public.set_member_stay($1,null,'2026-09-18')`, [leaver]);
    const stay = (await db.query<{ stay_from: string | null; stay_to: string }>(`select stay_from::text, stay_to::text from group_members where id=$1`, [leaver])).rows[0];
    assert.deepEqual(stay, { stay_from: null, stay_to: "2026-09-18" });
    await assert.rejects(db.query(`select public.set_member_stay($1,'2026-10-01','2026-09-01')`, [leaver]), /before/);

    const bill = {
      description: "Wi-Fi", amount_cents: 1000, split_type: "shares", period_start: "2026-09-12", period_end: "2026-10-11",
      payers: [{ member_id: me, amount_cents: 1000 }],
      splits: [{ member_id: me, amount_cents: 811, weight: 30 }, { member_id: leaver, amount_cents: 189, weight: 7 }],
    };
    const eid = (await db.query<{ id: string }>(`select public.save_expense(null,$1,$2::jsonb) id`, [gid, JSON.stringify(bill)])).rows[0].id;
    const saved = (await db.query(`select period_start::text, period_end::text from expenses where id=$1`, [eid])).rows[0];
    assert.deepEqual(saved, { period_start: "2026-09-12", period_end: "2026-10-11" });
    await assert.rejects(db.query(`select public.save_expense(null,$1,$2::jsonb)`, [gid, JSON.stringify({ ...bill, period_end: null })]), /period/);
    // Editing without a period clears it.
    await db.query(`select public.save_expense($1,$2,$3::jsonb)`, [eid, gid, JSON.stringify({ ...bill, period_start: null, period_end: null, split_type: "exact" })]);
    assert.equal((await db.query<{ p: string | null }>(`select period_start p from expenses where id=$1`, [eid])).rows[0].p, null);

    const up = { title: "PSE&G", amount_cents: 1000, period_start: "2026-05-12", period_end: "2026-09-09", shares: [{ member_id: me, amount_cents: 500 }, { member_id: leaver, amount_cents: 500 }] };
    const bid = (await db.query<{ id: string }>(`select public.save_upcoming_bill(null,$1,$2::jsonb) id`, [gid, JSON.stringify(up)])).rows[0].id;
    assert.deepEqual((await db.query(`select period_start::text, period_end::text from upcoming_bills where id=$1`, [bid])).rows[0], { period_start: "2026-05-12", period_end: "2026-09-09" });
    const paid = (await db.query<{ id: string }>(`select public.mark_upcoming_paid($1,$2::jsonb,'2026-10-01') id`, [bid, JSON.stringify([{ member_id: me, amount_cents: 1000 }])])).rows[0].id;
    assert.deepEqual((await db.query(`select period_start::text, period_end::text from expenses where id=$1`, [paid])).rows[0], { period_start: "2026-05-12", period_end: "2026-09-09" });

    await as(outsider);
    await assert.rejects(db.query(`select public.set_member_stay($1,'2026-01-01',null)`, [leaver]), /Not allowed/);
  } finally {
    await db.close();
  }
});

test("only the owner deletes a group, joining matches first names, and check marks survive a corrected estimate", async () => {
  const { db, as, user } = await freshDb();
  try {
    const owner = "11111111-1111-4111-8111-111111111111", mike = "33333333-3333-4333-8333-333333333333";
    await user(owner, "owner@example.invalid", "Owner");
    await user(mike, "mike@example.invalid", "Michael Jordan");
    await as(owner);
    const gid = (await db.query<{ gid: string }>(`select public.create_group('House','home','USD','[{"name":"Jordan"},{"name":"Sam"}]') gid`)).rows[0].gid;
    const code = (await db.query<{ c: string }>(`select invite_code c from groups where id=$1`, [gid])).rows[0].c;

    await as(mike);
    assert.equal((await db.query<{ s: unknown }>(`select public.suggest_spot($1) s`, [gid])).rows[0].s, null, "a surname is not a match");
    await db.query(`select public.join_group($1,null,true)`, [code]);
    await assert.rejects(db.query(`select public.delete_group($1)`, [gid]), /owner/);

    await as(owner);
    const ms = Object.fromEntries((await db.query<{ id: string; display_name: string }>(`select id, display_name from group_members where group_id=$1`, [gid])).rows.map((r) => [r.display_name, r.id]));
    const shares = (sam: number) => [{ member_id: ms.Owner, amount_cents: 6000 }, { member_id: ms.Sam, amount_cents: sam }];
    const bid = (await db.query<{ id: string }>(`select public.save_upcoming_bill(null,$1,$2::jsonb) id`, [gid, JSON.stringify({ title: "Wi-Fi", amount_cents: 13500, is_estimate: true, shares: shares(7500) })])).rows[0].id;
    await db.query(`select public.set_share_paid($1,$2,true)`, [bid, ms.Sam]);
    // The real bill came in higher: Sam's share goes from $75.00 to $75.20.
    await db.query(`select public.save_upcoming_bill($1,$2,$3::jsonb)`, [bid, gid, JSON.stringify({ title: "Wi-Fi", amount_cents: 13520, shares: shares(7520) })]);
    const sam = (await db.query<{ paid: boolean; sent: number }>(`select paid_at is not null paid, paid_cents::int sent from upcoming_bill_shares where bill_id=$1 and member_id=$2`, [bid, ms.Sam])).rows[0];
    assert.deepEqual(sam, { paid: true, sent: 7500 }, "Sam's tick stays, with the $75.00 actually sent");
    await db.query(`select public.mark_upcoming_paid($1,$2::jsonb,'2026-10-21')`, [bid, JSON.stringify([{ member_id: ms.Owner, amount_cents: 13520 }])]);
    const owed = (await db.query<{ b: number }>(`select public.member_balance($1)::int b`, [ms.Sam])).rows[0].b;
    assert.equal(owed, -20, "Sam still owes only the 20 cents the estimate missed");

    await db.query(`select public.delete_group($1)`, [gid]);
    assert.equal((await db.query(`select 1 from groups where id=$1`, [gid])).rows.length, 0);
  } finally {
    await db.close();
  }
});
