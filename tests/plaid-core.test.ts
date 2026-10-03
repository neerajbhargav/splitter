import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAID_NOT_CONFIGURED,
  accountBalanceCents,
  decimalToCents,
  describePlaidError,
  encodeBase64Url,
  mapAccount,
  mapAccountType,
  mapAccounts,
  mapCategory,
  mapKind,
  mapSyncPage,
  mapTransaction,
  openToken,
  readPlaidEnv,
  sealToken,
  tokenAad,
} from "../src/lib/plaid-core.ts";
import { DEFAULT_CATEGORIES } from "../src/lib/finance-types.ts";

const key = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const otherKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 200 - i)));
const goodEnv = { PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec", PLAID_ENV: "sandbox", PLAID_TOKEN_KEY: key };

test("readPlaidEnv validates every field", () => {
  const cfg = readPlaidEnv(goodEnv);
  assert.ok(cfg);
  assert.equal(cfg.env, "sandbox");
  assert.equal(cfg.redirectUri, null);
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_ENV: "production" })?.env, "production");
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_ENV: "development" }), null);
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_ENV: undefined }), null);
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_CLIENT_ID: "" }), null);
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_SECRET: undefined }), null);
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_TOKEN_KEY: undefined }), null);
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_TOKEN_KEY: btoa("short key") }), null);
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_TOKEN_KEY: key + key }), null, "64 bytes is not 32");
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_TOKEN_KEY: "not base64!!" }), null);
  // url-safe alphabet without padding is accepted
  const urlKey = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, i) => 250 - i));
  assert.ok(readPlaidEnv({ ...goodEnv, PLAID_TOKEN_KEY: urlKey }));
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_REDIRECT_URI: "https://app.example/oauth" })?.redirectUri, "https://app.example/oauth");
  assert.equal(readPlaidEnv({ ...goodEnv, PLAID_ENV: "production", PLAID_REDIRECT_URI: "http://x.example" })?.redirectUri, null);
  assert.equal(PLAID_NOT_CONFIGURED.code, "not_configured");
});

test("seal/open round trip, versioned format, fresh IV", async () => {
  const aad = tokenAad("user-1", "item-1");
  const sealed = await sealToken("access-sandbox-abc123", key, aad);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes("access-sandbox"));
  assert.equal(await openToken(sealed, key, aad), "access-sandbox-abc123");
  const again = await sealToken("access-sandbox-abc123", key, aad);
  assert.notEqual(again, sealed, "random IV per seal");
});

test("tamper, wrong AAD, wrong key and bad format all fail", async () => {
  const aad = tokenAad("user-1", "item-1");
  const sealed = await sealToken("access-sandbox-abc123", key, aad);
  const [v, iv, ct] = sealed.split(".");
  const flipped = (ct[5] === "A" ? "B" : "A");
  const tampered = `${v}.${iv}.${ct.slice(0, 5)}${flipped}${ct.slice(6)}`;
  await assert.rejects(openToken(tampered, key, aad), { name: "TokenSealError" });
  await assert.rejects(openToken(sealed, key, tokenAad("user-2", "item-1")), { name: "TokenSealError" });
  await assert.rejects(openToken(sealed, key, tokenAad("user-1", "item-2")), { name: "TokenSealError" });
  await assert.rejects(openToken(sealed, otherKey, aad), { name: "TokenSealError" });
  await assert.rejects(openToken(`v2.${iv}.${ct}`, key, aad), { name: "TokenSealError" });
  await assert.rejects(openToken("garbage", key, aad), { name: "TokenSealError" });
  // The error message never contains the token.
  await openToken(sealed, otherKey, aad).catch((e: Error) => assert.ok(!e.message.includes("access-sandbox")));
});

test("account type mapping table", () => {
  const table: [string, string | null, string | null][] = [
    ["depository", "checking", "checking"],
    ["depository", "savings", "savings"],
    ["depository", "cd", "savings"],
    ["depository", "money market", "savings"],
    ["depository", "cash management", "cash"],
    ["depository", "prepaid", "checking"],
    ["depository", null, "checking"],
    ["credit", "credit card", "credit"],
    ["loan", "student", "loan"],
    ["loan", "mortgage", "loan"],
    ["investment", "401k", "investment"],
    ["brokerage", null, "investment"],
    ["other", null, null],
    ["", null, null],
  ];
  for (const [type, sub, want] of table) assert.equal(mapAccountType(type, sub), want, `${type}/${sub}`);
});

test("cents rounding is exact decimal, half away from zero", () => {
  assert.equal(decimalToCents(12.345), 1235);
  assert.equal(decimalToCents(-12.345), -1235);
  assert.equal(decimalToCents(0.1 + 0.2), 30);
  assert.equal(decimalToCents(1.005), 101, "Math.round(1.005*100) would give 100");
  assert.equal(decimalToCents(-0.01), -1);
  assert.equal(decimalToCents(0.004), 0);
  assert.equal(decimalToCents(-0.004), 0);
  assert.equal(decimalToCents(1e9), 100_000_000_000);
  assert.equal(decimalToCents(1e-7), 0);
  assert.equal(decimalToCents(19.99), 1999);
  assert.equal(decimalToCents(1e21), null);
  assert.equal(decimalToCents(Number.NaN), null);
  assert.equal(decimalToCents(null), null);
  assert.equal(decimalToCents(10_000_000_001), null, "over FINANCE_MAX_CENTS");
  assert.equal(accountBalanceCents({ current: 1234.56, available: 1 }), 123456);
  assert.equal(accountBalanceCents({ current: null, available: -5.5 }), -550);
  assert.equal(accountBalanceCents({ current: null, available: null }), 0);
  assert.equal(accountBalanceCents(undefined), 0);
});

test("mapAccount / mapAccounts skip unsupported types and dedupe", () => {
  const row = mapAccount({ account_id: "a1", name: "Plaid Checking", official_name: "Official", mask: "0000", type: "depository", subtype: "checking", balances: { current: 110.01 } });
  assert.deepEqual(row, { account_id: "a1", name: "Plaid Checking", type: "checking", balance_cents: 11001, mask: "0000" });
  assert.equal(mapAccount({ account_id: "x", type: "other", balances: { current: 1 } }), null);
  const rows = mapAccounts([
    { account_id: "c1", name: "Card", type: "credit", subtype: "credit card", balances: { current: 410 }, mask: "3333" },
    { account_id: "c1", name: "Card", type: "credit", subtype: "credit card", balances: { current: 420 }, mask: "3333" },
    { account_id: "o1", type: "other", balances: { current: 1 } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].balance_cents, 42000);
  assert.deepEqual(mapAccounts(undefined), []);
});

test("category mapping uses DEFAULT_CATEGORIES names", () => {
  const names = new Set(DEFAULT_CATEGORIES.map((c) => c.name));
  const cases: [string | null, string | null, string | null][] = [
    ["INCOME", "INCOME_WAGES", null],
    ["TRANSFER_IN", "TRANSFER_IN_DEPOSIT", null],
    ["TRANSFER_OUT", "TRANSFER_OUT_SAVINGS", null],
    ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CAR_PAYMENT", "Debt payments"],
    ["FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES", "Groceries"],
    ["FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT", "Dining"],
    ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", "Shopping"],
    ["TRANSPORTATION", "TRANSPORTATION_GAS", "Transport"],
    ["TRAVEL", "TRAVEL_FLIGHTS", "Travel"],
    ["ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES", "Entertainment"],
    ["MEDICAL", "MEDICAL_PHARMACIES_AND_SUPPLEMENTS", "Health"],
    ["PERSONAL_CARE", "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS", "Health"],
    ["RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT", "Housing"],
    ["RENT_AND_UTILITIES", "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY", "Utilities"],
    ["HOME_IMPROVEMENT", "HOME_IMPROVEMENT_HARDWARE", "Housing"],
    ["GENERAL_SERVICES", "GENERAL_SERVICES_SUBSCRIPTION", "Subscriptions"],
    ["GENERAL_SERVICES", "GENERAL_SERVICES_AUTOMOTIVE", "Other"],
    ["BANK_FEES", "BANK_FEES_OVERDRAFT_FEES", "Other"],
    ["GOVERNMENT_AND_NON_PROFIT", "GOVERNMENT_AND_NON_PROFIT_DONATIONS", "Other"],
    [null, null, null],
  ];
  for (const [p, d, want] of cases) {
    const got = mapCategory(p, d);
    assert.equal(got, want, `${p}/${d}`);
    if (got) assert.ok(names.has(got), `${got} is a default category`);
  }
});

test("kind mapping flips Plaid's sign once and treats card payments as transfers", () => {
  assert.equal(mapKind("FOOD_AND_DRINK", 1250), "expense");
  assert.equal(mapKind("INCOME", -250000), "income");
  assert.equal(mapKind("GENERAL_MERCHANDISE", -1999), "income", "refund");
  assert.equal(mapKind("TRANSFER_IN", -5000), "transfer");
  assert.equal(mapKind("TRANSFER_OUT", 5000), "transfer");
  assert.equal(mapKind("LOAN_PAYMENTS", 30000, "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"), "transfer");
  assert.equal(mapKind("LOAN_PAYMENTS", 30000, "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT"), "expense");
});

test("mapTransaction builds the p_upserts row", () => {
  const row = mapTransaction({
    transaction_id: "tx1",
    account_id: "a1",
    amount: 12.345,
    date: "2026-09-02",
    authorized_date: "2026-09-01",
    name: "STARBUCKS #123",
    merchant_name: "Starbucks",
    pending: false,
    personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" },
  });
  assert.deepEqual(row, {
    transaction_id: "tx1", account_id: "a1", date: "2026-09-01", description: "Starbucks",
    amount_cents: 1235, kind: "expense", category: "Dining", pending: false,
  });
  const income = mapTransaction({ transaction_id: "tx2", account_id: "a1", amount: -2500, date: "2026-09-01", name: "PAYROLL", personal_finance_category: { primary: "INCOME", detailed: "INCOME_WAGES" } });
  assert.equal(income?.kind, "income");
  assert.equal(income?.amount_cents, 250000);
  assert.equal(income?.category, null);
  const card = mapTransaction({ transaction_id: "tx3", account_id: "c1", amount: 300, date: "2026-09-03", name: "AUTOPAY", personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" } });
  assert.equal(card?.kind, "transfer");
  assert.equal(card?.category, null);
  assert.equal(mapTransaction({ transaction_id: "z", account_id: "a1", amount: 0, date: "2026-09-01", name: "zero" }), null);
  assert.equal(mapTransaction({ transaction_id: "z", account_id: "a1", amount: 0.004, date: "2026-09-01", name: "rounds to zero" }), null);
  assert.equal(mapTransaction({ transaction_id: "z", account_id: "a1", amount: 5, date: "09/01/2026", name: "bad date" }), null);
  const long = mapTransaction({ transaction_id: "l", account_id: "a1", amount: 1, date: "2026-09-01", name: "x".repeat(300) });
  assert.equal(long?.description.length, 140);
  assert.equal(mapTransaction({ transaction_id: "n", account_id: "a1", amount: 1, date: "2026-09-01" })?.description, "Transaction");
});

test("sync page: pending -> posted replacement and dedupe by transaction_id", () => {
  const pending = { transaction_id: "pend-1", account_id: "a1", amount: 40, date: "2026-09-01", name: "Shell", pending: true, personal_finance_category: { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS" } };
  const first = mapSyncPage({ added: [pending], modified: [], removed: [], next_cursor: "c1", has_more: true });
  assert.equal(first.upserts[0].pending, true);
  assert.equal(first.nextCursor, "c1");
  assert.equal(first.hasMore, true);

  const posted = { ...pending, transaction_id: "post-1", pending: false, amount: 42.1 };
  const second = mapSyncPage({
    added: [posted],
    modified: [{ ...posted, name: "Shell Oil" }],
    removed: [{ transaction_id: "pend-1" }, { transaction_id: "post-1" }, "bare-id"],
    next_cursor: "c2",
    has_more: false,
    transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
  });
  assert.equal(second.upserts.length, 1, "deduped by id, last write wins");
  assert.equal(second.upserts[0].description, "Shell Oil");
  assert.equal(second.upserts[0].amount_cents, 4210);
  assert.equal(second.upserts[0].pending, false);
  assert.deepEqual(second.removed, ["pend-1", "bare-id"], "an id being upserted is never also removed");
  assert.equal(second.hasMore, false);
  assert.equal(second.updateStatus, "HISTORICAL_UPDATE_COMPLETE");

  const empty = mapSyncPage({});
  assert.deepEqual(empty, { upserts: [], removed: [], nextCursor: "", hasMore: false, updateStatus: null });
});

test("Plaid errors map to short messages and keep error_code", () => {
  const reauth = describePlaidError({ error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "secret detail" }, 400);
  assert.equal(reauth.reauth, true);
  assert.equal(reauth.status, 409);
  assert.equal(reauth.code, "ITEM_LOGIN_REQUIRED");
  assert.ok(!reauth.message.includes("secret detail"));
  assert.equal(describePlaidError({ error_type: "RATE_LIMIT_EXCEEDED", error_code: "TRANSACTIONS_SYNC_LIMIT" }).status, 429);
  assert.equal(describePlaidError({ error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS" }).status, 500);
  assert.equal(describePlaidError(null, 500).code, "PLAID_ERROR");
});
