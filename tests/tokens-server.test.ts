import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pg-harness.ts";

test("secret links: hashed at rest, a score sync lands as the owner, the calendar feed reads only your data, and turning a link off kills it", async () => {
  const { db, as, user } = await freshDb("20261021_group_fixes.sql", "20261021_personal_tokens.sql");
  try {
    const u = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
    await user(u, "me@example.invalid", "Me");
    await user(other, "other@example.invalid", "Other");
    await as(u);
    await db.query(`select public.ensure_finance_workspace($1,'USD')`, [u]);
    const scores = (await db.query<{ t: string }>(`select public.create_personal_token('scores') t`)).rows[0].t;
    const cal = (await db.query<{ t: string }>(`select public.create_personal_token('calendar') t`)).rows[0].t;
    assert.match(scores, /^[0-9a-f]{64}$/);
    const stored = (await db.query<{ h: string }>(`select string_agg(token_hash, ',') h from personal_tokens`)).rows[0].h;
    assert.ok(!stored.includes(scores) && !stored.includes(cal), "only hashes are stored");

    // A signed-in browser can't read the table at all.
    await db.exec(`set role authenticated`);
    await assert.rejects(db.query(`select * from public.personal_tokens`), /permission denied/);
    await db.exec(`reset role`);

    // The runner calls with no session, only the token.
    await as("");
    const r = (await db.query<{ r: { inserted: number } }>(`select public.sync_credit_scores_with_token($1,$2::jsonb) r`,
      [scores, JSON.stringify([{ bureau: "experian", score: 712, model: "FICO 8", as_of: "2026-10-20", source: "runner" }])])).rows[0].r;
    assert.equal(r.inserted, 1);
    assert.equal((await db.query<{ user_id: string }>(`select user_id from finance_credit_scores`)).rows[0].user_id, u);
    assert.equal((await db.query<{ u: string | null }>(`select auth.uid() u`)).rows[0].u, null, "acting as the owner ends with the call");
    await assert.rejects(db.query(`select public.sync_credit_scores_with_token($1,'[]'::jsonb)`, [cal]), /Invalid or turned-off link/, "a calendar token can't sync scores");
    await assert.rejects(db.query(`select public.calendar_feed($1)`, ["0".repeat(64)]), /Invalid or turned-off link/);

    const feed = (await db.query<{ f: { settings: { currency: string }; bills: unknown[]; subscriptions: unknown[] } }>(`select public.calendar_feed($1) f`, [cal])).rows[0].f;
    assert.equal(feed.settings.currency, "USD");
    assert.deepEqual([feed.bills, feed.subscriptions], [[], []]);

    await as(u);
    await db.query(`select public.revoke_personal_token('calendar')`);
    await as("");
    await assert.rejects(db.query(`select public.calendar_feed($1)`, [cal]), /Invalid or turned-off link/);
    await as(other);
    assert.deepEqual((await db.query<{ s: unknown }>(`select public.personal_token_status() s`)).rows[0].s, {}, "status only shows your own links");
  } finally {
    await db.close();
  }
});
