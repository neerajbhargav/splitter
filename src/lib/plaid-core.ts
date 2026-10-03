/**
 * Plaid bank sync, pure half. No network, no Next.js, no Supabase, so tests can import it directly.
 *
 * - readPlaidEnv: validates server env (secrets never leave the server).
 * - sealToken / openToken: AES-256-GCM (WebCrypto) for the Plaid access_token, bound to `${userId}:${itemId}`.
 * - map*: Plaid responses -> the jsonb rows the plaid_* SQL RPCs accept.
 *
 * Money rules: integer cents only. Plaid sends floats; we round from the shortest decimal string
 * (what Plaid actually sent in JSON), half away from zero, never Math.round(x * 100).
 * Plaid's sign (positive = money leaving the account) is flipped exactly once, in mapKind/mapTransaction.
 */
import { FINANCE_MAX_CENTS, type AccountType, type TxKind } from "./finance-types.ts";

/* ---------------------------------------------------------------- env */

export type PlaidEnvName = "sandbox" | "production";
export type PlaidConfig = {
  clientId: string;
  secret: string;
  env: PlaidEnvName;
  /** Base64 of exactly 32 bytes (AES-256 key). */
  tokenKey: string;
  /** Optional OAuth redirect URI registered in the Plaid dashboard (https only). */
  redirectUri: string | null;
};

export const PLAID_NOT_CONFIGURED = {
  error: "Bank sync isn't set up on this server yet.",
  code: "not_configured",
} as const;

/** Returns null when anything required is missing or malformed. Never throws, never echoes values. */
export function readPlaidEnv(env: Record<string, string | undefined>): PlaidConfig | null {
  const clientId = (env.PLAID_CLIENT_ID ?? "").trim();
  const secret = (env.PLAID_SECRET ?? "").trim();
  const name = (env.PLAID_ENV ?? "").trim().toLowerCase();
  const tokenKey = (env.PLAID_TOKEN_KEY ?? "").trim();
  if (!clientId || !secret || !tokenKey) return null;
  if (name !== "sandbox" && name !== "production") return null;
  const key = decodeBase64(tokenKey);
  if (!key || key.length !== 32) return null;
  let redirectUri: string | null = null;
  const rawRedirect = (env.PLAID_REDIRECT_URI ?? "").trim();
  if (rawRedirect) {
    try {
      const u = new URL(rawRedirect);
      if (u.protocol === "https:" || (name === "sandbox" && u.hostname === "localhost")) redirectUri = u.toString();
    } catch {
      redirectUri = null;
    }
  }
  return { clientId, secret, env: name, tokenKey, redirectUri };
}

export function plaidBaseUrl(env: PlaidEnvName): string {
  return env === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
}

/* ---------------------------------------------------------------- base64 helpers */

/** Strict standard/url-safe base64 decode. Returns null on anything malformed. */
export function decodeBase64(input: string): Uint8Array | null {
  let s = input.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  s = s.replace(/=+$/, "");
  if (s.length % 4 === 1) return null;
  s += "=".repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------------------------------------------------------------- token sealing */

const SEAL_VERSION = "v1";
const IV_BYTES = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class TokenSealError extends Error {
  constructor(message = "Saved bank login could not be read. Reconnect this bank.") {
    super(message);
    this.name = "TokenSealError";
  }
}

async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const raw = decodeBase64(keyB64);
  if (!raw || raw.length !== 32) throw new TokenSealError("Bank token key is invalid.");
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Additional authenticated data that binds a sealed token to one user and one Plaid Item. */
export function tokenAad(userId: string, itemId: string): string {
  return `${userId}:${itemId}`;
}

/** AES-256-GCM seal -> `v1.<b64url iv>.<b64url ciphertext+tag>`. */
export async function sealToken(token: string, keyB64: string, aad: string): Promise<string> {
  if (!token) throw new TokenSealError("Nothing to seal.");
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad), tagLength: 128 },
    key,
    enc.encode(token),
  );
  return `${SEAL_VERSION}.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ct))}`;
}

/** Throws TokenSealError on wrong key, wrong AAD, tampering, or an unknown format. */
export async function openToken(sealed: string, keyB64: string, aad: string): Promise<string> {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 3 || parts[0] !== SEAL_VERSION) throw new TokenSealError();
  const iv = decodeBase64(parts[1]);
  const ct = decodeBase64(parts[2]);
  if (!iv || iv.length !== IV_BYTES || !ct || ct.length < 17) throw new TokenSealError();
  const key = await importAesKey(keyB64);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer>, additionalData: enc.encode(aad), tagLength: 128 },
      key,
      ct as Uint8Array<ArrayBuffer>,
    );
    return dec.decode(pt);
  } catch {
    throw new TokenSealError();
  }
}

/* ---------------------------------------------------------------- money */

/**
 * Exact decimal -> integer cents, half away from zero, from the shortest round-trip decimal string.
 * 12.345 -> 1235, -0.01 -> -1, 1e9 -> 100000000000. Returns null for non-finite or out-of-range values.
 */
export function decimalToCents(value: unknown): number | null {
  const x = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (x === 0) return 0;
  const neg = x < 0;
  let s = String(Math.abs(x));
  if (/e/i.test(s)) {
    if (Math.abs(x) >= 1) return null; // >= 1e21: far beyond FINANCE_MAX_CENTS anyway
    s = Math.abs(x).toFixed(20); // tiny value; toFixed(20) is exact enough to see the 3rd decimal
  }
  const [intPart, fracPart = ""] = s.split(".");
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  const frac = (fracPart + "000").slice(0, 3);
  let cents = Number(intPart) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents) || cents > FINANCE_MAX_CENTS) return null;
  return neg && cents !== 0 ? -cents : cents;
}

export type PlaidBalances = { current?: number | null; available?: number | null } | null | undefined;

/** Signed integer cents from Plaid balances (current, falling back to available, then 0). Null if unrepresentable. */
export function accountBalanceCents(balances: PlaidBalances): number | null {
  const raw = balances?.current ?? balances?.available ?? 0;
  return decimalToCents(raw);
}

/* ---------------------------------------------------------------- accounts */

/** Folio's mapping. Unknown Plaid types return null and are skipped. */
export function mapAccountType(type: string | null | undefined, subtype: string | null | undefined): AccountType | null {
  const t = (type ?? "").toLowerCase();
  const st = (subtype ?? "").toLowerCase();
  if (t === "credit") return "credit";
  if (t === "loan") return "loan";
  if (t === "investment" || t === "brokerage") return "investment";
  if (t === "depository") {
    if (/savings|^cd$|money market/.test(st)) return "savings";
    if (/cash management/.test(st)) return "cash";
    return "checking";
  }
  return null;
}

export type PlaidAccount = {
  account_id?: string;
  name?: string | null;
  official_name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  balances?: PlaidBalances;
};

/** Row shape for plaid_upsert_accounts(p_accounts). */
export type AccountRow = {
  account_id: string;
  name: string;
  type: AccountType;
  balance_cents: number;
  mask: string | null;
};

function clip(text: string, max: number): string {
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}

export function mapAccount(a: PlaidAccount): AccountRow | null {
  if (!a || typeof a.account_id !== "string" || !a.account_id) return null;
  const type = mapAccountType(a.type, a.subtype);
  if (!type) return null;
  const balance = accountBalanceCents(a.balances);
  if (balance === null) return null;
  const name = clip(a.name || a.official_name || "", 100) || "Bank account";
  const mask = typeof a.mask === "string" && /^[0-9A-Za-z]{2,4}$/.test(a.mask) ? a.mask : null;
  return { account_id: a.account_id.slice(0, 150), name, type, balance_cents: balance, mask };
}

export function mapAccounts(list: unknown): AccountRow[] {
  if (!Array.isArray(list)) return [];
  const seen = new Map<string, AccountRow>();
  for (const a of list) {
    const row = mapAccount(a as PlaidAccount);
    if (row) seen.set(row.account_id, row);
  }
  return [...seen.values()].slice(0, 100);
}

/* ---------------------------------------------------------------- transactions */

/** Must match DEFAULT_CATEGORIES names in finance-types.ts (tests enforce it). */
export type PlaidCategoryName =
  | "Housing" | "Groceries" | "Utilities" | "Transport" | "Health" | "Debt payments"
  | "Dining" | "Shopping" | "Subscriptions" | "Entertainment" | "Travel" | "Other";

/**
 * Plaid personal_finance_category -> SPLITTER category name.
 * Null means "no expense category": income, transfers, or no category from Plaid at all.
 * Known-but-unmapped primaries fall back to "Other" like Folio did.
 */
export function mapCategory(pfcPrimary: string | null | undefined, pfcDetailed: string | null | undefined): PlaidCategoryName | null {
  const p = (pfcPrimary ?? "").toUpperCase();
  // Match on the detailed suffix only: every RENT_AND_UTILITIES_* code contains "RENT" in its prefix
  // (Folio's /rent/ test therefore sent all utilities to Housing).
  const full = (pfcDetailed ?? "").toUpperCase();
  const d = full.startsWith(`${p}_`) ? full.slice(p.length + 1) : full;
  if (!p) return null;
  if (p === "INCOME" || p.startsWith("TRANSFER_")) return null;
  switch (p) {
    case "LOAN_PAYMENTS":
      return "Debt payments";
    case "FOOD_AND_DRINK":
      return /GROCERIES|SUPERMARKET/.test(d) ? "Groceries" : "Dining";
    case "GENERAL_MERCHANDISE":
      return "Shopping";
    case "TRANSPORTATION":
      return "Transport";
    case "TRAVEL":
      return "Travel";
    case "ENTERTAINMENT":
      return "Entertainment";
    case "MEDICAL":
    case "PERSONAL_CARE":
      return "Health";
    case "RENT_AND_UTILITIES":
      return /RENT|MORTGAGE/.test(d) ? "Housing" : "Utilities";
    case "HOME_IMPROVEMENT":
      return "Housing";
    case "GENERAL_SERVICES":
      return /SUBSCRIPTION|SOFTWARE/.test(d) ? "Subscriptions" : "Other";
    case "BANK_FEES":
      return "Other";
    default:
      return "Other";
  }
}

/** Plaid sign convention: positive amount = money out (expense), negative = money in (income). */
export function mapKind(pfcPrimary: string | null | undefined, signedAmount: number, pfcDetailed?: string | null): TxKind {
  const p = (pfcPrimary ?? "").toUpperCase();
  const d = (pfcDetailed ?? "").toUpperCase();
  if (p === "TRANSFER_IN" || p === "TRANSFER_OUT") return "transfer";
  if (p === "LOAN_PAYMENTS" && d === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return "transfer";
  return signedAmount > 0 ? "expense" : "income";
}

export type PlaidTransaction = {
  transaction_id?: string;
  account_id?: string;
  amount?: number;
  date?: string;
  authorized_date?: string | null;
  name?: string | null;
  merchant_name?: string | null;
  pending?: boolean;
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null;
};

/** Row shape for plaid_apply_sync(p_upserts). amount_cents is a positive magnitude; kind gives direction. */
export type TransactionRow = {
  transaction_id: string;
  account_id: string;
  date: string;
  description: string;
  amount_cents: number;
  kind: TxKind;
  category: PlaidCategoryName | null;
  pending: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Null when the row can't be stored (no id, zero/unrepresentable amount, bad date). */
export function mapTransaction(t: PlaidTransaction): TransactionRow | null {
  if (!t || typeof t.transaction_id !== "string" || !t.transaction_id) return null;
  if (typeof t.account_id !== "string" || !t.account_id) return null;
  const signed = decimalToCents(t.amount);
  if (signed === null || signed === 0) return null;
  const date = (t.authorized_date && ISO_DATE.test(t.authorized_date) ? t.authorized_date : t.date) ?? "";
  if (!ISO_DATE.test(date)) return null;
  const primary = t.personal_finance_category?.primary ?? null;
  const detailed = t.personal_finance_category?.detailed ?? null;
  const kind = mapKind(primary, signed, detailed);
  return {
    transaction_id: t.transaction_id.slice(0, 150),
    account_id: t.account_id.slice(0, 150),
    date,
    description: clip(t.merchant_name || t.name || "", 140) || "Transaction",
    amount_cents: Math.abs(signed),
    kind,
    category: kind === "expense" ? mapCategory(primary, detailed) : null,
    pending: t.pending === true,
  };
}

export type SyncPage = {
  upserts: TransactionRow[];
  removed: string[];
  nextCursor: string;
  hasMore: boolean;
  /** Plaid's transactions_update_status, e.g. NOT_STARTED while history is still loading. */
  updateStatus: string | null;
};

/**
 * One /transactions/sync page -> RPC payload. added+modified are upserted (deduped by transaction_id,
 * last write wins). Pending->posted: Plaid adds the posted row with a new id and lists the pending id in
 * `removed`, which the RPC deletes after the upserts.
 */
export function mapSyncPage(data: unknown): SyncPage {
  const d = (data ?? {}) as Record<string, unknown>;
  const rows = new Map<string, TransactionRow>();
  for (const list of [d.added, d.modified]) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const row = mapTransaction(t as PlaidTransaction);
      if (row) rows.set(row.transaction_id, row);
    }
  }
  const removed = new Set<string>();
  if (Array.isArray(d.removed)) {
    for (const r of d.removed) {
      const id = typeof r === "string" ? r : (r as { transaction_id?: unknown })?.transaction_id;
      if (typeof id === "string" && id && !rows.has(id)) removed.add(id.slice(0, 150));
    }
  }
  return {
    upserts: [...rows.values()],
    removed: [...removed],
    nextCursor: typeof d.next_cursor === "string" ? d.next_cursor : "",
    hasMore: d.has_more === true,
    updateStatus: typeof d.transactions_update_status === "string" ? d.transactions_update_status : null,
  };
}

/** institution_name from /accounts/get (item.institution_name), else null. */
export function institutionFromAccounts(data: unknown): { name: string | null; id: string | null } {
  const item = ((data ?? {}) as { item?: { institution_name?: unknown; institution_id?: unknown } }).item ?? {};
  const name = typeof item.institution_name === "string" && item.institution_name.trim() ? clip(item.institution_name, 100) : null;
  const id = typeof item.institution_id === "string" && item.institution_id ? item.institution_id : null;
  return { name, id };
}

/* ---------------------------------------------------------------- errors */

export type PlaidErrorInfo = { status: number; code: string; message: string; reauth: boolean; retry: boolean };

/** Plaid error body -> short user-facing message. Keeps error_code; never includes request data. */
export function describePlaidError(body: unknown, httpStatus = 400): PlaidErrorInfo {
  const b = (body ?? {}) as { error_code?: unknown; error_type?: unknown; display_message?: unknown };
  const code = typeof b.error_code === "string" && /^[A-Z0-9_]{1,80}$/.test(b.error_code) ? b.error_code : "PLAID_ERROR";
  const type = typeof b.error_type === "string" ? b.error_type : "";
  const display = typeof b.display_message === "string" && b.display_message.trim() ? clip(b.display_message, 200) : null;
  const out = (status: number, message: string, reauth = false, retry = false): PlaidErrorInfo => ({ status, code, message, reauth, retry });
  switch (code) {
    case "ITEM_LOGIN_REQUIRED":
    case "PENDING_EXPIRATION":
    case "ACCESS_NOT_GRANTED":
      return out(409, "Your bank needs you to sign in again. Use Fix login.", true);
    case "INVALID_ACCESS_TOKEN":
    case "ITEM_NOT_FOUND":
      return out(410, "This bank link is no longer valid. Remove it and connect again.");
    case "INVALID_PUBLIC_TOKEN":
      return out(400, "That bank link expired before it finished. Try connecting again.");
    case "INVALID_LINK_TOKEN":
      return out(400, "The bank connection window expired. Try again.");
    case "PRODUCT_NOT_READY":
    case "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION":
      return out(503, "Your bank is still updating. Try again in a minute.", false, true);
    case "RATE_LIMIT_EXCEEDED":
    case "TRANSACTIONS_SYNC_LIMIT":
    case "TRANSACTIONS_LIMIT":
      return out(429, "Too many bank refreshes. Wait a minute and try again.", false, true);
    case "INSTITUTION_DOWN":
    case "INSTITUTION_NOT_RESPONDING":
    case "INSTITUTION_NOT_AVAILABLE":
      return out(502, display ?? "Your bank isn't responding right now. Try again later.", false, true);
    case "NO_ACCOUNTS":
      return out(400, "No supported accounts were found at that bank.");
    case "INVALID_PRODUCT":
    case "PRODUCTS_NOT_SUPPORTED":
    case "PRODUCT_NOT_ENABLED":
      return out(400, "This bank doesn't support transaction sync.");
  }
  if (type === "RATE_LIMIT_EXCEEDED") return out(429, "Too many bank requests. Wait a minute and try again.", false, true);
  if (type === "INSTITUTION_ERROR") return out(502, display ?? "Your bank isn't responding right now. Try again later.", false, true);
  if (type === "API_ERROR" || httpStatus >= 500) return out(502, "The bank sync service had a problem. Try again shortly.", false, true);
  if (type === "INVALID_REQUEST" || type === "INVALID_INPUT") return out(500, "Bank sync is misconfigured on this server.");
  return out(502, display ?? "The bank sync request failed. Try again.");
}
