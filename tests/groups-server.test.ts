import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb as db0 } from "./pg-harness.ts";

const freshDb = () => db0("20261021_group_fixes.sql");

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

test("as the API's signed-in role, invites, joining and removing a member still work, and the 3 internal helpers are refused", async () => {
  const { db, as, user } = await freshDb();
  try {
    const owner = "11111111-1111-4111-8111-111111111111", cleo = "44444444-4444-4444-8444-444444444444";
    await user(owner, "owner@example.invalid", "Owner");
    await user(cleo, "cleo@example.invalid", "Cleo Park");
    await as(owner);
    const gid = (await db.query<{ gid: string }>(`select public.create_group('House','home','USD','[{"name":"Cleo"},{"name":"Sam"}]') gid`)).rows[0].gid;
    const code = (await db.query<{ c: string }>(`select invite_code c from groups where id=$1`, [gid])).rows[0].c;
    const spot = async (name: string) => (await db.query<{ id: string; user_id: string | null }>(`select id, user_id from group_members where group_id=$1 and display_name=$2`, [gid, name])).rows[0];
    const sam = (await spot("Sam")).id;

    await as(cleo);
    await db.exec("set role authenticated");
    const inv = (await db.query<{ j: { suggested: { how: string } | null; placeholders: { display_name: string; looks_like_me: boolean }[] } }>(`select public.get_invite($1) j`, [code])).rows[0].j;
    assert.equal(inv.suggested?.how, "name", "get_invite still suggests the matching spot (suggest_spot, as the definer)");
    assert.deepEqual(inv.placeholders.map((p) => [p.display_name, p.looks_like_me]), [["Cleo", true], ["Sam", false]], "and flags it (spot_looks_like_me)");
    await assert.rejects(db.query(`select public.member_balance($1)`, [sam]), /permission denied/);
    await assert.rejects(db.query(`select public.spot_looks_like_me($1)`, [sam]), /permission denied/);
    await assert.rejects(db.query(`select public.suggest_spot($1)`, [gid]), /permission denied/);
    await db.query(`select public.join_group($1)`, [code]);
    await db.exec("reset role");
    assert.equal((await spot("Cleo")).user_id, cleo, "join_group claimed the matching spot");

    await as(owner);
    await db.exec("set role authenticated");
    await db.query(`select public.remove_member($1)`, [sam]); // checks member_balance, as the definer
    await db.exec("reset role");
    assert.equal((await db.query(`select 1 from group_members where id=$1 and is_active`, [sam])).rows.length, 0, "Sam was removed");
  } finally {
    await db.close();
  }
});
