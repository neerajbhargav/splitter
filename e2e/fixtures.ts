/**
 * Synthetic data for the E2E smoke tests. Every name and number here is made up.
 * The stub server (stub-supabase.ts) serves these rows, and the specs assert against them.
 */
export const STUB_PORT = 54329;
export const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;

export const USER_ID = "00000000-0000-4000-8000-00000000a001";
export const GROUP_ID = "00000000-0000-4000-8000-00000000b001";
export const MEMBER = {
  ada: "00000000-0000-4000-8000-00000000c001",
  ben: "00000000-0000-4000-8000-00000000c002",
  cleo: "00000000-0000-4000-8000-00000000c003",
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** JWT-shaped so the auth client can decode it. The stub never checks the signature. */
export const ACCESS_TOKEN = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER_ID, role: "authenticated", aud: "authenticated", exp: 4102444800 })}.e2e`;

export const USER = {
  id: USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "ada@example.test",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: "2026-09-01T00:00:00Z",
};

/** The cookie @supabase/ssr reads: "sb-<first label of the Supabase host>-auth-token", base64url JSON. */
export function sessionCookie() {
  const session = { access_token: ACCESS_TOKEN, token_type: "bearer", expires_in: 3600, expires_at: 4102444800, refresh_token: "e2e-refresh", user: USER };
  return { name: `sb-${new URL(STUB_URL).hostname.split(".")[0]}-auth-token`, value: `base64-${b64(session)}` };
}

const at = "2026-09-01T12:00:00Z";
const member = (id: string, display_name: string, extra: Record<string, unknown> = {}) => ({
  id, group_id: GROUP_ID, user_id: null, display_name, email: null, phone: null, color: "#6b8afd", role: "member",
  is_active: true, stay_from: null, stay_to: null, created_at: at, ...extra,
});
const expense = (id: string, description: string, cents: number, payer: string, split: string[], date: string) => ({
  id, group_id: GROUP_ID, description, amount_cents: cents, currency: "USD", category: "general", expense_date: date,
  notes: null, split_type: "equal", is_payment: false, receipt_path: null, repeat_interval: "none", next_repeat_on: null,
  created_by: USER_ID, updated_by: USER_ID, created_at: `${date}T12:00:00Z`, updated_at: `${date}T12:00:00Z`, deleted_at: null,
  period_start: null, period_end: null,
  expense_payers: [{ member_id: payer, amount_cents: cents }],
  expense_splits: split.map((m) => ({ member_id: m, amount_cents: cents / split.length, weight: null })),
});

/**
 * Raw debts: Ben owes Ada 30, Cleo owes Ada 30, Cleo owes Ben 30 (3 payments).
 * Net: Ada +60, Ben 0, Cleo -60, so simplify settles it in 1 payment: Cleo pays Ada 60.
 */
export const TABLES: Record<string, Record<string, unknown>[]> = {
  profiles: [{ id: USER_ID, display_name: "Ada", email: USER.email, avatar_url: null, default_currency: "USD" }],
  groups: [{
    id: GROUP_ID, name: "Test House", kind: "home", currency: "USD", simplify_debts: true, default_split: null,
    invite_code: "e2etest", created_by: USER_ID, created_at: at, updated_at: at,
  }],
  group_members: [
    member(MEMBER.ada, "Ada", { user_id: USER_ID, role: "owner" }),
    member(MEMBER.ben, "Ben"),
    // Moved out on Sep 10, so a September bill split by days charges Cleo for 10 days.
    member(MEMBER.cleo, "Cleo", { stay_to: "2026-09-10" }),
  ],
  expenses: [
    expense("00000000-0000-4000-8000-00000000d002", "Cleaning supplies", 6000, MEMBER.ben, [MEMBER.ben, MEMBER.cleo], "2026-09-06"),
    expense("00000000-0000-4000-8000-00000000d001", "Groceries", 9000, MEMBER.ada, [MEMBER.ada, MEMBER.ben, MEMBER.cleo], "2026-09-05"),
  ],
  finance_settings: [{
    user_id: USER_ID, currency: "USD", monthly_gross_cents: 0, monthly_net_cents: 0, housing_cents: 0, car_cents: 0,
    categories_seeded: true, pay_cycle: null, pay_anchor: null, pay_day2: null, paycheck_cents: 0, created_at: at, updated_at: at,
  }],
};
