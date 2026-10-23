// Authorization matrix, generated from pg_catalog. A victim user fills every public table through the
// real RPCs. Then an outsider (signed in, in none of the victim's groups) and an anonymous caller try
// to read every table and call every function they are granted, aimed at the victim's ids.
// A call passes if it raises, or if it returns nothing of the victim's and changes no victim row.
// New tables and functions fail here until they get fixture rows and a case below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pg-harness.ts";

const V = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // victim
const O = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // outsider
type Db = Awaited<ReturnType<typeof freshDb>>["db"];
type Fx = Record<string, string>;

// Outsider arguments by parameter name. Row ids point at the victim's rows; secrets are wrong guesses.
// `me` is what the caller claims to be: the victim's user, group and members, or the outsider's own.
type Me = { user: string; gid: string; members: string[] };
const byName = (f: Fx, me: Me): Record<string, unknown> => ({
  gid: me.gid, p_group: me.gid, mid: f.roommate, eid: f.expense, bid: f.bill, p_user: me.user, p_currency: "USD", other: V,
  p_connection: f.connection, p_account: f.account, p_batch: f.batch, p_ids: [f.txn], p_category: f.category, p_reassign: null,
  p_code: "not-the-invite-code", p_token: "0".repeat(64), p_claim: f.sam, p_new: false, p_kind: "calendar",
  p_name: "Mallory", p_email: "mallory@example.invalid", p_phone: null, p_simplify: false, p_members: [],
  p_from: "2026-01-01", p_to: null, p_date: "2026-10-01", p_paid: true, p_payers: [{ member_id: me.members[0], amount_cents: 6000 }],
  p_rows: [], p_upserts: [], p_removed: [], p_accounts: [], p_cursor: "c", p_status: "error", p_error: "x",
  p_item_id: "item-shared-1", p_institution: "Bank", p_ciphertext: `v1.${"x".repeat(40)}`, c: 1234, n: 1, t: "not-a-uuid", d: "2026-01-01", iv: "monthly",
});

// One entry per function granted to authenticated: the arguments that differ from byName, and why.
// Every save_* aims at the victim's existing row, so an accepted call would overwrite it.
const CASES: Record<string, (f: Fx, me: Me) => Record<string, unknown>> = {
  _token_hash: () => ({}), // pure hash of its input
  actor_name: () => ({}),
  add_member: () => ({}),
  calendar_feed: () => ({}),
  create_group: () => ({ p_kind: "home" }), // creates the outsider's own group
  create_personal_token: () => ({}), // the outsider's own token
  delete_budget_month: (f) => ({ p_id: f.budget }),
  delete_expense: () => ({}),
  delete_finance_account: (f) => ({ p_id: f.account }),
  delete_finance_category: (f) => ({ p_id: f.category }),
  delete_finance_connection: () => ({}),
  delete_finance_credit_score: (f) => ({ p_id: f.score }),
  delete_finance_holding: (f) => ({ p_id: f.holding }),
  delete_finance_paycheck: (f) => ({ p_id: f.paycheck }),
  delete_finance_transaction: (f) => ({ p_id: f.txn }),
  delete_group: () => ({}),
  delete_personal_subscription: (f) => ({ p_id: f.sub }),
  delete_upcoming_bill: () => ({}),
  ensure_finance_workspace: () => ({}),
  ensure_profile: () => ({}),
  fmt_cents: () => ({}),
  get_invite: () => ({}),
  import_finance_transactions: () => ({ p_rows: [{ date: "2026-01-02", description: "x", amount_cents: 1, kind: "expense", category_id: null, external_id: "csv:dddddddddddddddd" }] }),
  is_group_member: () => ({}),
  join_group: () => ({}),
  leave_group: () => ({}),
  mark_upcoming_paid: () => ({}),
  member_balance: () => ({}),
  member_color: () => ({}),
  name_tokens: () => ({}),
  new_invite_code: () => ({}),
  next_repeat: () => ({}),
  personal_token_status: () => ({}),
  plaid_apply_sync: () => ({}),
  plaid_connection_secret: () => ({}),
  plaid_save_connection: () => ({}),
  plaid_set_status: () => ({}),
  plaid_upsert_accounts: () => ({}),
  process_recurring: () => ({}), // must post only the caller's own recurring expenses
  recategorize_finance_transactions: () => ({}),
  regenerate_invite: () => ({}),
  remove_member: () => ({}),
  restore_expense: () => ({}),
  revoke_personal_token: () => ({}),
  save_budget_month: (f) => ({ p: { id: f.budget, month: "2020-01-01", income_cents: 1, limits: [] } }),
  save_default_split: (f, me) => ({ p: { type: "equal", members: [{ member_id: me.members[0], weight: 1 }] } }),
  save_expense: (f, me) => ({ p_id: f.expense, p: expense(me.members, "Hijacked") }),
  save_finance_account: (f) => ({ p: { id: f.account, name: "x", type: "checking", balance_cents: 1 } }),
  save_finance_category: (f) => ({ p: { id: f.category, name: "x", kind: "needs" } }),
  save_finance_credit_score: (f) => ({ p: { id: f.score, bureau: "experian", score: 300, as_of: "2020-01-10" } }),
  save_finance_debt_plan: () => ({ p: { strategy: "snowball", extra_monthly_cents: 0, rollover: true, priority: [], payments: [], extra_changes: [], lump_sums: [] } }),
  save_finance_holding: (f) => ({ p: { id: f.holding, account_id: f.brokerage, symbol: "X", shares: "1", price_cents: 1 } }),
  save_finance_pay_schedule: () => ({ p: { pay_cycle: "weekly", pay_anchor: "2020-01-03", paycheck_cents: 1 } }),
  save_finance_paycheck: (f) => ({ p: { id: f.paycheck, pay_date: "2020-01-15", amount_cents: 1, allocations: [], note: "", received: false } }),
  save_finance_profile: () => ({ p: { monthly_gross_cents: 1, monthly_net_cents: 1, housing_cents: 0, car_cents: 0 } }),
  save_finance_settings: () => ({}),
  save_finance_transaction: (f) => ({ p: { id: f.txn, date: "2020-01-05", description: "x", amount_cents: 1, kind: "expense" } }),
  save_personal_subscription: (f) => ({ p: { id: f.sub, name: "x", amount_cents: 1, cycle: "monthly", anchor_date: "2020-01-15", status: "active", notes: "" } }),
  save_upcoming_bill: (f, me) => ({ p_id: f.bill, p: { title: "Hijacked", amount_cents: 6000, shares: [{ member_id: me.members[0], amount_cents: 6000 }] } }),
  set_member_stay: () => ({}),
  set_share_paid: (f, me) => ({ mid: me.members[0] }),
  shares_group_with: () => ({}),
  spot_looks_like_me: (f) => ({ mid: f.sam }),
  suggest_spot: () => ({}),
  // Same bureau, day and model as the victim's score, so a sync keyed on anything but the user would overwrite it.
  sync_credit_scores_with_token: () => ({ p_rows: [{ bureau: "experian", score: 300, model: "FICO 8", as_of: "2020-01-10" }] }),
  sync_finance_credit_scores: () => ({ p_rows: [{ bureau: "experian", score: 300, model: "FICO 8", as_of: "2020-01-10" }] }),
  try_uuid: () => ({}),
  unclaim_my_spot: () => ({}),
  undo_finance_import: () => ({}),
  update_group: () => ({ p_name: "Hijacked", p_kind: null, p_currency: null }),
  update_member: () => ({}),
  update_profile: () => ({ p_currency: "USD" }), // the outsider's own profile
};

// Known gaps, pinned so they cannot spread unnoticed, and so a fix makes this test ask for the entry's removal.
// Each value is the leak this test observes today, for any caller. None of these is called by the app;
// get_invite calls the last two internally, as the definer, so revoking EXECUTE from anon and authenticated
// would close all three without changing the app.
const KNOWN: Record<string, string> = {
  // No membership check: anyone holding a member id, signed in or not, reads that member's balance.
  member_balance: "returned -23000",
  // No membership or invite check: a caller whose first name matches an unclaimed spot learns that spot's member id.
  suggest_spot: 'returned {"how": "name", "member_id": ',
  // No membership check: says whether a spot in any group matches the caller's name or email.
  spot_looks_like_me: "returned true",
};

/** A $30 bill paid by the first member and split equally (1 or 3 members). */
function expense(members: string[], description: string) {
  return {
    description, amount_cents: 3000, category: "general", expense_date: "2026-01-05", split_type: "equal",
    payers: [{ member_id: members[0], amount_cents: 3000 }],
    splits: members.map((m) => ({ member_id: m, amount_cents: 3000 / members.length })),
  };
}

const one = async <T>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

/** The victim's world: every public table gets rows, through the same RPCs the app calls. */
async function victimFixture(db: Db, as: (id: string) => Promise<unknown>): Promise<Fx> {
  await as(V);
  const f: Fx = {};
  const id = async (sql: string, params: unknown[] = []) => String((await one<{ id: string }>(db, `select (${sql})::text id`, params)).id);
  const fin = async (fn: string, p: unknown) => id(`public.${fn}($1::jsonb,$2::uuid,'USD')`, [JSON.stringify(p), V]);

  f.gid = await id(`public.create_group('Victim house','home','USD','[{"name":"Victim roommate"},{"name":"Sam"}]')`);
  const ms = (await db.query<{ id: string; display_name: string; user_id: string | null }>(`select id, display_name, user_id from group_members where group_id=$1`, [f.gid])).rows;
  f.me = ms.find((m) => m.user_id === V)!.id;
  f.roommate = ms.find((m) => m.display_name === "Victim roommate")!.id;
  f.sam = ms.find((m) => m.display_name === "Sam")!.id;
  const all = [f.me, f.roommate, f.sam];
  f.expense = await id(`public.save_expense(null,$1,$2::jsonb)`, [f.gid, JSON.stringify(expense(all, "Victim rent"))]);
  // A monthly expense from the past, so process_recurring has something of the victim's it must not post.
  await id(`public.save_expense(null,$1,$2::jsonb)`, [f.gid, JSON.stringify({ ...expense(all, "Victim internet"), expense_date: "2025-01-01", repeat_interval: "monthly" })]);
  await db.query(`select public.process_recurring()`);
  await db.query(`select public.delete_expense($1)`, [await id(`public.save_expense(null,$1,$2::jsonb)`, [f.gid, JSON.stringify(expense(all, "Victim deleted"))])]);
  f.bill = await id(`public.save_upcoming_bill(null,$1,$2::jsonb)`, [f.gid, JSON.stringify({ title: "Victim power", amount_cents: 6000, shares: [{ member_id: f.me, amount_cents: 3000 }, { member_id: f.roommate, amount_cents: 3000 }] })]);
  await db.query(`select public.save_default_split($1,$2::jsonb)`, [f.gid, JSON.stringify({ type: "shares", members: [{ member_id: f.me, weight: 2 }, { member_id: f.roommate, weight: 1 }] })]);
  await db.query(`insert into public.comments(expense_id, group_id, user_id, body) values ($1,$2,$3,'Victim comment')`, [f.expense, f.gid, V]);

  await db.query(`select public.ensure_finance_workspace($1,'USD')`, [V]);
  f.account = await fin("save_finance_account", { name: "Victim checking", type: "checking", balance_cents: 100000 });
  f.card = await fin("save_finance_account", { name: "Victim card", type: "credit", balance_cents: 250000, apr_bps: 2499, minimum_cents: 5000, in_payoff: true });
  f.brokerage = await fin("save_finance_account", { name: "Victim brokerage", type: "investment", balance_cents: 0 });
  f.holding = await fin("save_finance_holding", { account_id: f.brokerage, symbol: "VTI", name: "Victim fund", shares: "2", price_cents: 29000 });
  f.category = await fin("save_finance_category", { name: "Victim pets", kind: "needs" });
  f.budget = await fin("save_budget_month", { month: "2020-01-01", income_cents: 540000, limits: [{ category_id: f.category, limit_cents: 5000 }] });
  f.txn = await fin("save_finance_transaction", { date: "2020-01-05", description: "Victim vet", amount_cents: 9000, kind: "expense", account_id: f.account, category_id: f.category });
  f.sub = await fin("save_personal_subscription", { name: "Victim music", amount_cents: 1099, cycle: "monthly", anchor_date: "2020-01-15", status: "active", notes: "" });
  f.paycheck = await fin("save_finance_paycheck", { pay_date: "2020-01-15", amount_cents: 200000, allocations: [], note: "Victim pay", received: false });
  f.score = await fin("save_finance_credit_score", { bureau: "experian", score: 712, model: "FICO 8", as_of: "2020-01-10", source: "", note: "" });
  await fin("save_finance_debt_plan", { strategy: "avalanche", extra_monthly_cents: 1000, rollover: true, priority: [f.card], payments: [], extra_changes: [], lump_sums: [] });
  await fin("save_finance_pay_schedule", { pay_cycle: "biweekly", pay_anchor: "2020-01-03", paycheck_cents: 200000 });
  await fin("save_finance_profile", { monthly_gross_cents: 750000, monthly_net_cents: 540000, housing_cents: 185000, car_cents: 0 });
  const batch = await one<{ r: { batch: string } }>(db, `select public.import_finance_transactions($1,$2::jsonb,$3,'USD') r`,
    [f.account, JSON.stringify([{ date: "2020-01-10", description: "Victim coffee", amount_cents: 450, kind: "expense", category_id: null, external_id: "csv:aaaaaaaaaaaaaaaa" }]), V]);
  f.batch = batch.r.batch;
  f.connection = await id(`public.plaid_save_connection('item-shared-1','Victim Bank','v1.victim-ciphertext',$1,'USD')`, [V]);
  await db.query(`select public.plaid_upsert_accounts($1,$2::jsonb,$3,'USD')`, [f.connection, JSON.stringify([{ account_id: "victim-acc", name: "Victim plaid checking", type: "checking", balance_cents: 50000, mask: "1234" }]), V]);
  await db.query(`select public.create_personal_token('calendar')`);
  await db.query(`select public.create_personal_token('scores')`);
  await as("");
  return f;
}

type Snapshot = Map<string, number>;
async function snapshot(db: Db, tables: string[]): Promise<Snapshot> {
  const sql = tables.map((t) => `select '${t}' t, to_jsonb(x)::text j from public.${t} x`).join(" union all ");
  const out: Snapshot = new Map();
  for (const r of (await db.query<{ t: string; j: string }>(sql)).rows) out.set(`${r.t} ${r.j}`, (out.get(`${r.t} ${r.j}`) ?? 0) + 1);
  return out;
}
const minus = (a: Snapshot, b: Snapshot) => [...a].filter(([k, n]) => (b.get(k) ?? 0) < n).map(([k]) => k);

const arg = (v: unknown) => (v === null ? null : Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? `{${v.join(",")}}` : typeof v === "object" ? JSON.stringify(v) : String(v));

// Why a call was refused. Only the first four are authorization checks. Anything else means the call
// stopped at input validation before it reached its check, so it proves nothing: fix its CASES entry.
const REASONS: [string, RegExp][] = [
  ["no EXECUTE grant", /permission denied/i],
  ["not signed in", /not signed in|sign in first/i],
  ["owner lock: p_user is not the caller", /signed-in account changed/i],
  // "already removed" is undo_finance_import's answer for a batch that is not the caller's.
  ["ownership or membership check", /not in this group|not allowed|not found|no longer exists|already removed|turned-off link|invite link is invalid|must belong to this group|choose (one|another) of your|already claimed/i],
];
const reason = (msg: string) => REASONS.find(([, re]) => re.test(msg))?.[0] ?? null;

/** Runs the whole matrix on a loaded database and returns what it saw. The caller asserts. */
async function matrix(db: Db, as: (id: string) => Promise<unknown>, user: (id: string, email: string, name: string) => Promise<unknown>) {
  await user(V, "victim@example.invalid", "Victim Vee");
  await user(O, "sam.outsider@example.invalid", "Sam Outsider");
  const f = await victimFixture(db, as);

  // 1. Every public table has row level security.
  const tables = (await db.query<{ t: string; rls: boolean }>(`select c.relname t, c.relrowsecurity rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by 1`)).rows;
  const names = tables.map((t) => t.t);
  // A view runs with its owner's rights and skips the caller's RLS unless it is security_invoker.
  // Materialized views and foreign tables cannot have RLS at all. None exist today.
  const views = (await db.query<{ v: string }>(
    `select c.relname v from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('v','m','f') and coalesce(array_to_string(c.reloptions, ','), '') !~ 'security_invoker=(true|on|1)' order by 1`)).rows;

  // 2. Every SECURITY DEFINER function pins search_path, trigger functions included.
  const definers = (await db.query<{ name: string; ok: boolean }>(
    `select p.proname name, coalesce(array_to_string(p.proconfig, ','), '') ~ '(^|,)search_path=' ok
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef order by 1`)).rows;
  const fns = (await db.query<{ name: string; args: string; auth: boolean; anon: boolean; setof: boolean }>(
    `select p.proname name, pg_get_function_identity_arguments(p.oid) args, p.proretset setof,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') auth, has_function_privilege('anon', p.oid, 'EXECUTE') anon
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.prorettype <> 'trigger'::regtype order by 1`)).rows;

  // 3. Coverage: every table holds victim rows, and every granted function has a case.
  const victimRows = await snapshot(db, names);
  const filled = new Set([...victimRows.keys()].map((k) => k.split(" ")[0]));
  const granted = fns.filter((x) => x.auth || x.anon);
  // Anything that identifies the victim: every uuid in their rows (not the outsider's), and the word Victim.
  const markers = [...new Set([...victimRows.keys()].flatMap((k) => k.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []))].filter((u) => u !== O);
  const victimIn = (s: string) => /victim/i.test(s) || markers.some((m) => s.includes(m));

  // The outsider's own group and finance workspace, so the outsider can pass every check that is about
  // who the caller is and still has to be stopped by the check on whose row it is.
  await as(O);
  const ownGid = (await one<{ id: string }>(db, `select public.create_group('Outsider house','home','USD','[]')::text id`)).id;
  const own: Me = { user: O, gid: ownGid, members: [(await one<{ id: string }>(db, `select id::text id from group_members where group_id=$1 and user_id=$2`, [ownGid, O])).id] };
  await db.query(`select public.ensure_finance_workspace($1,'USD')`, [O]);
  await as("");
  const before = await snapshot(db, names);

  const leaks: string[] = [];
  const unproven: string[] = [];
  const tally: Record<string, number> = {};
  const count = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
  const theVictim: Me = { user: V, gid: f.gid, members: [f.me, f.roommate, f.sam] };
  // "outsider" claims the victim's user id and group, so most checks refuse on who the caller is.
  // "outsider as self" sends its own user id and group with the victim's row ids: the IDOR case, where
  // only the row-ownership filter stands between the caller and the victim's row.
  const callers = [
    { role: "authenticated", uid: O, label: "outsider", me: theVictim, lockOk: true },
    { role: "authenticated", uid: O, label: "outsider as self", me: own, lockOk: false },
    { role: "anon", uid: "", label: "anon", me: theVictim, lockOk: true },
  ];

  // 4. Reads: neither caller sees a victim row in any table.
  for (const c of callers) {
    if (c.label === "outsider as self") continue; // a read takes no arguments, so it is the same as "outsider"
    for (const t of names) {
      await db.exec("begin");
      await db.query(`select set_config('request.jwt.claim.sub',$1,true)`, [c.uid]);
      await db.exec(`set local role ${c.role}`);
      try {
        const j = (await one<{ j: string }>(db, `select coalesce(jsonb_agg(to_jsonb(x)),'[]')::text j from public.${t} x`)).j;
        if (victimIn(j)) leaks.push(`${c.label} reads ${t}: ${j.slice(0, 200)}`);
        count(`${c.label} table reads with no victim rows`);
      } catch (e) {
        if (!/permission denied/.test(String(e))) leaks.push(`${c.label} select ${t}: ${String(e).slice(0, 160)}`);
        count(`${c.label} table reads denied`);
      }
      await db.exec("rollback");
    }
  }

  // 5. RPCs: refused by an authorization check, or returns nothing of the victim's and changes no victim row.
  const observed: Record<string, string> = {};
  const missing: string[] = [];
  for (const fn of granted) {
    if (!CASES[fn.name]) continue;
    const params = fn.args ? fn.args.split(", ").map((a) => a.slice(0, a.indexOf(" "))) : [];
    const types = fn.args ? fn.args.split(", ").map((a) => a.slice(a.indexOf(" ") + 1).replace(/ DEFAULT .*/, "")) : [];
    const call = `public.${fn.name}(${types.map((ty, i) => `$${i + 1}::${ty}`).join(",")})`;
    const sql = fn.setof ? `select coalesce(jsonb_agg(to_jsonb(x)),'null')::text r from ${call} x` : `select to_jsonb(${call})::text r`;
    for (const c of callers) {
      if (!(c.role === "anon" ? fn.anon : fn.auth)) continue;
      const values = { ...byName(f, c.me), ...CASES[fn.name](f, c.me) };
      for (const p of params) if (!(p in values)) missing.push(`${fn.name}(${p})`);
      await db.exec("begin");
      await db.query(`select set_config('request.jwt.claim.sub',$1,true)`, [c.uid]);
      await db.exec(`set local role ${c.role}`);
      let out: string | null = null;
      let refusal: string | null = null;
      try {
        out = (await one<{ r: string | null }>(db, sql, params.map((p) => arg(values[p])))).r;
      } catch (e) {
        refusal = e instanceof Error ? e.message : String(e);
      }
      if (refusal !== null) {
        const why = reason(refusal);
        if (!why || (!c.lockOk && why.startsWith("owner lock"))) unproven.push(`${c.label} ${fn.name}: ${refusal}`);
        else count(`${c.label} RPC calls refused: ${why}`);
      } else {
        await db.exec("reset role");
        const after = await snapshot(db, names);
        const changed = [...minus(before, after), ...minus(after, before)].filter(victimIn);
        const r = out === null ? null : JSON.parse(out);
        // A bare true or number carries no marker, so count it as victim data. As self, the outsider gets true
        // answers about its own group, so there it counts only when the call named a victim id.
        const bare = r === true || (typeof r === "number" && r !== 0);
        const aimed = c.me !== own || params.some((p) => victimIn(JSON.stringify(values[p]) ?? ""));
        const why = [
          ...(changed.length ? [`changed victim rows: ${changed.slice(0, 2).join(" | ").slice(0, 240)}`] : []),
          ...((bare && aimed) || (out !== null && victimIn(out)) ? [`returned ${out!.slice(0, 160)}`] : []),
        ];
        const msg = `${c.label} ${fn.name}: ${why.join("; ")}`;
        if (!why.length) count(`${c.label} RPC calls answered with nothing of the victim's`);
        else if (KNOWN[fn.name] && why.length === 1 && why[0].startsWith(KNOWN[fn.name])) {
          observed[fn.name] = msg;
          count(`${c.label} RPC calls in a known gap`);
        } else leaks.push(msg);
      }
      await db.exec("rollback");
    }
  }
  return { tables, names, views, definers, granted, filled, leaks, unproven, observed, missing, tally };
}

function report(t: { diagnostic: (s: string) => void }, m: Awaited<ReturnType<typeof matrix>>) {
  for (const [k, n] of Object.entries(m.tally).sort()) t.diagnostic(`${k}: ${n}`);
  t.diagnostic(`functions granted: ${m.granted.length}; SECURITY DEFINER functions: ${m.definers.length}; tables: ${m.names.length}; known gaps: ${Object.keys(KNOWN).join(", ") || "none"}`);
}

// A fresh schema.sql, and schema.sql with the two 2026-10-21 migrations applied on top (twice). The second
// checks that re-running those migrations on a current database leaves no hole. It does not rebuild an older
// database: the harness has no copy of one.
for (const [label, migrations] of [["fresh schema", []], ["schema plus the 2026-10-21 migrations", ["20261021_group_fixes.sql", "20261021_personal_tokens.sql"]]] as const) test(`authorization matrix (${label}): RLS on every table, search_path on every definer, and outsiders refused by every RPC`, async (t) => {
  const { db, as, user } = await freshDb(...migrations);
  try {
    const m = await matrix(db, as, user);
    report(t, m);
    assert.deepEqual(m.tables.filter((x) => !x.rls).map((x) => x.t), [], "tables without RLS");
    assert.deepEqual(m.views.map((v) => v.v), [], "views without security_invoker, materialized views or foreign tables in public: they bypass RLS");
    assert.deepEqual(m.definers.filter((d) => !d.ok).map((d) => d.name), [], "SECURITY DEFINER functions without search_path");
    assert.deepEqual(m.names.filter((x) => !m.filled.has(x)), [], "tables with no fixture rows: add some to victimFixture");
    assert.deepEqual(m.granted.map((x) => x.name).filter((n) => !CASES[n]), [], "granted functions with no case in CASES");
    assert.deepEqual(Object.keys(CASES).filter((n) => !m.granted.some((x) => x.name === n)), [], "CASES entries for functions that no longer exist or are no longer granted");
    assert.deepEqual(m.missing, [], "parameters with no outsider value");
    assert.deepEqual(m.unproven, [], "refusals that came from input validation (or, for 'outsider as self', the owner lock) instead of an authorization check: fix the CASES entry so the call reaches its check");
    assert.deepEqual(m.leaks, [], "outsider or anon reached victim data");
    assert.deepEqual(Object.keys(KNOWN).filter((k) => !m.observed[k]), [], "known gaps that no longer leak: remove them from KNOWN");
  } finally {
    await db.close();
  }
});

// The matrix must catch an IDOR (a write that checks who you are but not whose row it is). Plant two in
// a scratch database: a finance delete without its owner filter, and a group bill update that trusts the
// bill id without checking its group. The "outsider" pass alone missed both, because the owner lock and
// the group-membership check refuse it first.
test("authorization matrix catches planted IDORs that only the 'outsider as self' pass can see", async (t) => {
  const { db, as, user } = await freshDb();
  try {
    const def = async (sig: string) => (await one<{ d: string }>(db, `select pg_get_functiondef($1::regprocedure) d`, [sig])).d;
    const plant = async (sig: string, from: RegExp, to: string) => {
      const d = await def(sig);
      assert.match(d, from, `${sig}: the planted change no longer applies; update this test`);
      await db.exec(d.replace(from, to));
    };
    await plant("public.delete_finance_transaction(uuid,uuid,text)", /where id=p_id and user_id=public\._finance_owner_lock\(p_user,p_currency\)/,
      "where id=p_id and public._finance_owner_lock(p_user,p_currency) is not null");
    await plant("public.save_upcoming_bill(uuid,uuid,jsonb)", /(update public\.upcoming_bills set[\s\S]*?where id = p_id) and group_id = p_group/, "$1");
    const m = await matrix(db, as, user);
    report(t, m);
    const caught = (fn: string) => m.leaks.filter((l) => l.includes(` ${fn}: changed victim rows`)).map((l) => l.slice(0, l.indexOf(":")));
    assert.deepEqual(caught("delete_finance_transaction"), ["outsider as self delete_finance_transaction"]);
    assert.deepEqual(caught("save_upcoming_bill"), ["outsider as self save_upcoming_bill"]);
  } finally {
    await db.close();
  }
});
