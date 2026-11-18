import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pg-harness.ts";

const G = "33333333-3333-4333-8333-333333333333"; // guest who later connects Google
const B = "44444444-4444-4444-8444-444444444444"; // someone who added the guest's email to their group

for (const migration of [[], ["20261118_guests.sql"]]) test(`a guest who connects Google keeps their data and gets their name, email and spots${migration.length ? " (migration on top)" : ""}`, async () => {
  const { db, as, user } = await freshDb(...migration);
  try {
    const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
    await db.query(`insert into auth.users(id,email,raw_user_meta_data,is_anonymous) values ($1,null,'{"name":"Guest"}',true)`, [G]);
    await user(B, "b@example.invalid", "Ben");
    await as(B);
    const bens = (await one<{ id: string }>(`select public.create_group('Ben house','home','USD','[{"name":"Sam","email":"sam@example.invalid"}]')::text id`)).id;

    await as(G);
    await db.query(`select public.ensure_profile()`);
    assert.deepEqual(await one(`select display_name, email from profiles where id=$1`, [G]), { display_name: "Guest", email: null });
    const trip = (await one<{ id: string }>(`select public.create_group('Trip','trip','USD','[{"name":"Pal"}]')::text id`)).id;
    await db.query(`select public.ensure_finance_workspace($1,'USD')`, [G]);
    await db.query(`select public.save_finance_account($1::jsonb,$2::uuid,'USD')`, [JSON.stringify({ name: "Wallet", type: "cash", balance_cents: 500 }), G]);
    assert.equal((await one<{ n: string }>(`select display_name n from group_members where group_id=$1 and user_id=$2`, [trip, G])).n, "Guest");

    // linkIdentity: same user id, now with an email and a Google identity.
    await db.query(`update auth.users set email='Sam@Example.invalid', is_anonymous=false where id=$1`, [G]);
    await db.query(`insert into auth.identities(user_id,provider,identity_data) values ($1,'google','{"full_name":"Sam Lee","email":"sam@example.invalid","picture":"https://example.invalid/p.png"}')`, [G]);
    await db.query(`select public.ensure_profile()`);
    assert.deepEqual(await one(`select display_name, email, avatar_url from profiles where id=$1`, [G]),
      { display_name: "Sam Lee", email: "sam@example.invalid", avatar_url: "https://example.invalid/p.png" });
    assert.equal((await one<{ n: string }>(`select display_name n from group_members where group_id=$1 and user_id=$2`, [trip, G])).n, "Sam Lee", "the guest's own spot takes the real name");
    assert.equal(Number((await one<{ n: string }>(`select count(*)::text n from group_members where group_id=$1 and user_id=$2`, [bens, G])).n), 1, "the spot Ben added by email is claimed");
    assert.equal(Number((await one<{ n: string }>(`select count(*)::text n from finance_accounts where user_id=$1`, [G])).n), 1, "Money data stays");

    // A name the guest chose is kept.
    await db.query(`update profiles set display_name='Sammy', email=null where id=$1`, [G]);
    await db.query(`select public.ensure_profile()`);
    assert.equal((await one<{ n: string }>(`select display_name n from profiles where id=$1`, [G])).n, "Sammy");
  } finally {
    await db.close();
  }
});

test("purge_stale_guests deletes only guests unused for the whole window, and no caller can run it", async () => {
  const { db, as } = await freshDb("20261118_guests.sql");
  try {
    const old = "now() - interval '40 days'";
    const ids = { stale: "55555555-5555-4555-8555-555555555555", active: "66666666-6666-4666-8666-666666666666", fresh: "77777777-7777-4777-8777-777777777777", real: "88888888-8888-4888-8888-888888888888" };
    await db.query(`insert into auth.users(id,email,raw_user_meta_data,is_anonymous,created_at) values
      ($1,null,'{"name":"Guest"}',true,${old}), ($2,null,'{"name":"Guest"}',true,${old}), ($3,null,'{"name":"Guest"}',true,now()), ($4,'r@example.invalid','{"name":"Real"}',false,${old})`,
      [ids.stale, ids.active, ids.fresh, ids.real]);
    await db.query(`insert into auth.sessions(user_id,created_at,updated_at,refreshed_at) values ($1,${old},now() - interval '2 days',null), ($2,${old},${old},${old})`, [ids.active, ids.stale]);
    // The stale guest made a solo group, which goes with them.
    await as(ids.stale);
    const gid = (await db.query<{ id: string }>(`select public.create_group('Solo','home','USD','[]')::text id`)).rows[0].id;
    await as("");

    await assert.rejects(db.query(`select public.purge_stale_guests(3)`), /at least 7 days/);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`begin; set local role ${role};`);
      await assert.rejects(db.query(`select public.purge_stale_guests(30)`), /permission denied/, role);
      await db.exec("rollback");
    }
    assert.equal((await db.query<{ n: number }>(`select public.purge_stale_guests(30) n`)).rows[0].n, 1);
    const left = (await db.query<{ id: string }>(`select id::text from auth.users order by id`)).rows.map((r) => r.id);
    assert.deepEqual(left, [ids.active, ids.fresh, ids.real]);
    assert.equal((await db.query(`select 1 from groups where id=$1`, [gid])).rows.length, 0);
  } finally {
    await db.close();
  }
});
