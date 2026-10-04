/**
 * Plaid bank sync, server-only glue for the /api/finance/plaid/* route handlers.
 * Never import this from client code: it reads PLAID_SECRET and PLAID_TOKEN_KEY.
 *
 * Everything runs with the signed-in user's Supabase session (supabaseServer() reads their cookies);
 * the plaid_* RPCs enforce ownership through auth.uid(). No service-role key is used.
 * The Plaid access_token is decrypted only in memory, only here, and is never logged or returned.
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  PLAID_NOT_CONFIGURED,
  describePlaidError,
  openToken,
  plaidBaseUrl,
  readPlaidEnv,
  tokenAad,
  type PlaidConfig,
  type PlaidErrorInfo,
} from "@/lib/plaid-core";

type SupabaseServer = Awaited<ReturnType<typeof supabaseServer>>;

export type PlaidContext = {
  supabase: SupabaseServer;
  userId: string;
  currency: string;
  config: PlaidConfig;
  body: Record<string, unknown>;
};

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 16_384;

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

/** Thrown inside handlers; converted to a JSON response by withPlaid(). */
export class HttpError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** A Plaid API failure. `info` is already user-safe. */
export class PlaidApiError extends Error {
  constructor(public info: PlaidErrorInfo) {
    super(info.message);
    this.name = "PlaidApiError";
  }
}

export function getPlaidConfig(): PlaidConfig | null {
  return readPlaidEnv(process.env);
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Same-origin check for browsers that send Origin. JSON content-type already forces a CORS preflight. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    /* fallthrough */
  }
  if (originHost !== host) throw new HttpError(403, "Request blocked.", "forbidden");
}

export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "Send JSON.", "bad_request");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.", "bad_request");
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Send a JSON object.", "bad_request");
  }
}

/**
 * Shared front door for the POST routes: env check, JSON body, signed-in user, body.userId === session user,
 * body.currency well-formed. Any HttpError / PlaidApiError thrown by `fn` becomes a short JSON error.
 */
export async function withPlaid(req: Request, fn: (ctx: PlaidContext) => Promise<NextResponse>): Promise<NextResponse> {
  try {
    const config = getPlaidConfig();
    if (!config) return json(PLAID_NOT_CONFIGURED, 503);
    assertSameOrigin(req);
    const body = await readJsonBody(req);
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.getUser();
    const user = data?.user;
    if (error || !user) return json({ error: "Sign in to connect a bank.", code: "unauthorized" }, 401);
    if (body.userId !== user.id) {
      return json({ error: "Your signed-in account changed. Reload and try again.", code: "stale_context" }, 409);
    }
    const currency = body.currency;
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      return json({ error: "A valid finance currency is required.", code: "bad_request" }, 400);
    }
    return await fn({ supabase, userId: user.id, currency, config, body });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    if (e instanceof PlaidApiError) {
      const { status, code, message, reauth } = e.info;
      return json({ error: message, code: reauth ? "reauth" : code, error_code: code }, status);
    }
    // Do not log the error object itself: upstream errors could carry request context.
    console.error("[plaid] unexpected failure:", e instanceof Error ? e.name : typeof e);
    return json({ error: "Bank sync failed. Try again.", code: "server_error" }, 500);
  }
}

/* ---------------------------------------------------------------- Plaid HTTP */

/** POST to Plaid with credentials. Throws PlaidApiError (user-safe) on any failure. */
export async function plaidPost<T = Record<string, unknown>>(
  config: PlaidConfig,
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${plaidBaseUrl(config.env)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "Plaid-Version": "2020-09-14" },
      body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...payload }),
      cache: "no-store",
      signal: AbortSignal.timeout(28_000),
    });
  } catch {
    throw new PlaidApiError({ status: 504, code: "PLAID_UNREACHABLE", message: "Couldn't reach the bank sync service. Try again.", reauth: false, retry: true });
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data) throw new PlaidApiError(describePlaidError(data, res.status));
  return data as T;
}

/* ---------------------------------------------------------------- Supabase RPC */

/** Calls a plaid_* RPC with p_user/p_currency appended. Maps SQL exceptions to short errors. */
export async function rpc<T>(ctx: PlaidContext, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await ctx.supabase.rpc(fn, { ...args, p_user: ctx.userId, p_currency: ctx.currency });
  if (error) {
    const msg = String(error.message ?? "");
    if (/signed-in account changed|currency changed|draft currency/i.test(msg)) throw new HttpError(409, msg, "stale_context");
    if (/not signed in/i.test(msg)) throw new HttpError(401, "Sign in to connect a bank.", "unauthorized");
    if (/connection not found/i.test(msg)) throw new HttpError(404, "That bank connection wasn't found.", "not_found");
    if (/up to 20 banks/i.test(msg)) throw new HttpError(400, msg, "limit");
    // SQL messages from these RPCs are written for users and contain no secrets; keep them short.
    throw new HttpError(400, msg.slice(0, 200) || "Couldn't save bank data.", "db_error");
  }
  return data as T;
}

export type ConnectionSecret = { itemId: string; accessToken: string; cursor: string | null };

/** Reads and decrypts one connection's access token for the signed-in user. */
export async function loadConnection(ctx: PlaidContext, connectionId: unknown): Promise<ConnectionSecret & { connectionId: string }> {
  if (!isUuid(connectionId)) throw new HttpError(400, "Choose a bank connection.", "bad_request");
  const rows = await rpc<{ item_id: string; token_ciphertext: string; sync_cursor: string | null }[] | null>(
    ctx,
    "plaid_connection_secret",
    { p_connection: connectionId },
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new HttpError(404, "That bank connection wasn't found.", "not_found");
  let accessToken: string;
  try {
    accessToken = await openToken(row.token_ciphertext, ctx.config.tokenKey, tokenAad(ctx.userId, row.item_id));
  } catch {
    await setStatus(ctx, connectionId, "error", "Saved bank login could not be read. Reconnect this bank.");
    throw new HttpError(409, "Saved bank login could not be read. Remove this bank and connect it again.", "token_unreadable");
  }
  return { connectionId, itemId: row.item_id, accessToken, cursor: row.sync_cursor || null };
}

/** Best-effort status write; never masks the original error. */
export async function setStatus(ctx: PlaidContext, connectionId: string, status: "ok" | "reauth" | "error", message: string | null) {
  try {
    await rpc<void>(ctx, "plaid_set_status", { p_connection: connectionId, p_status: status, p_error: message });
  } catch {
    /* ignore */
  }
}

/** Records reauth/error status for a Plaid failure on a known connection, then rethrows it. */
export async function failConnection(ctx: PlaidContext, connectionId: string, e: unknown): Promise<never> {
  if (e instanceof PlaidApiError) {
    if (e.info.reauth) await setStatus(ctx, connectionId, "reauth", e.info.message);
    else if (!e.info.retry) await setStatus(ctx, connectionId, "error", e.info.message);
  }
  throw e;
}

/** Best-effort /item/remove so a failed save doesn't leave a billable orphan Item at Plaid. */
export async function removeItemQuietly(config: PlaidConfig, accessToken: string) {
  try {
    await plaidPost(config, "/item/remove", { access_token: accessToken });
  } catch {
    /* ignore */
  }
}
