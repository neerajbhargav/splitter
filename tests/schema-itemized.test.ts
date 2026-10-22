// A fresh deployment runs supabase/schema.sql alone (README setup step 2). server-tools.test.ts applies the
// 2026-10-01 and 2026-10-02 migrations on top, which replace the itemized functions, so it cannot see a
// bug that lives only in schema.sql. This test checks the itemized money math on schema.sql alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pg-harness.ts";
import { itemizedSplit } from "../src/lib/itemization.ts";
import { convertItemizedBill } from "../src/lib/itemized-currency.ts";

test("schema.sql alone: itemized splits and FX conversion match the client to the cent, and an itemized bill saves", async () => {
  const { db, as, user } = await freshDb();
  try {
    const U = "11111111-1111-4111-8111-111111111111";
    await user(U, "test@example.invalid", "Test Person");
    await as(U);
    const gid = (await db.query<{ gid: string }>(`select public.create_group('Fresh install','other','USD','[{"name":"Other"},{"name":"Third"}]') gid`)).rows[0].gid;
    const ms = (await db.query<{ id: string }>(`select id from group_members where group_id=$1 order by id`, [gid])).rows.map((m) => m.id);

    for (let i = 0; i < 30; i++) {
      const items = [
        { description: "A", amount_cents: 101 + i * 37, member_ids: [...ms].reverse() },
        { description: "B", amount_cents: 200 + i * 11, member_ids: [ms[0], ms[2]] },
      ];
      const want = itemizedSplit(items, 7 + i, 9 + i, ms);
      assert.equal(want.problem, null);
      const sql = (await db.query<{ v: { member_id: string; amount_cents: number }[] }>(`select public.itemized_splits($1,$2::jsonb,$3,$4) v`, [gid, JSON.stringify(items), 7 + i, 9 + i])).rows[0].v;
      assert.deepEqual(sql.map((p) => [p.member_id, p.amount_cents]), [...want.out].sort(([a], [b]) => a.localeCompare(b)).map(([id, p]) => [id, p.amount]), `itemized_splits case ${i}`);

      const fx = convertItemizedBill(items, 7 + i, 9 + i, 1.1355 + i / 1000);
      const conv = (await db.query<{ v: unknown }>(`select public.convert_itemized_bill($1,$2::jsonb,$3,$4,$5) v`, [gid, JSON.stringify(items), 7 + i, 9 + i, fx.total])).rows[0].v;
      assert.deepEqual(conv, { items: fx.items, tax_cents: fx.tax_cents, tip_cents: fx.tip_cents }, `convert_itemized_bill case ${i}`);
    }

    // End to end: the dinner from server-tools.test.ts saves with splits that add up to the bill.
    const items = [{ description: "Food", amount_cents: 1000, member_ids: [ms[0]] }, { description: "Drink", amount_cents: 2000, member_ids: [ms[1]] }];
    const input = { description: "Dinner", amount_cents: 3900, split_type: "equal", items, tax_cents: 300, tip_cents: 600, payers: [{ member_id: ms[0], amount_cents: 3900 }], splits: [] };
    const eid = (await db.query<{ id: string }>(`select public.save_expense(null,$1,$2::jsonb) id`, [gid, JSON.stringify(input)])).rows[0].id;
    const splits = (await db.query<{ amount_cents: number }>(`select amount_cents::int from expense_splits where expense_id=$1 order by amount_cents`, [eid])).rows;
    assert.deepEqual(splits.map((s) => s.amount_cents), [1300, 2600]);
  } finally {
    await db.close();
  }
});
