/**
 * Plaid bank sync, browser half. Talks only to SPLITTER's /api/finance/plaid/* routes.
 * Never sees an access_token: the server seals it and keeps it.
 *
 * Errors are PlaidClientError with a friendly message and a `code`:
 *   "reauth"         -> show "Fix login" (call repairConnection)
 *   "not_configured" -> hide bank sync
 *   "stale_context"  -> the signed-in account or finance currency changed; reload
 *   "unauthorized"   -> sign in again
 *   anything else    -> show the message
 * Closing Plaid Link without finishing resolves null (not an error).
 */
import type { FinanceContext } from "@/lib/finance-types";

const LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const BASE = "/api/finance/plaid";
const MAX_PAGES = 40;

type LinkExitError = { error_code?: string; error_message?: string; display_message?: string | null } | null;
type LinkHandler = { open(): void; exit?(opts?: { force?: boolean }): void; destroy?(): void };
type PlaidGlobal = {
  create(opts: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess(publicToken: string, metadata: unknown): void;
    onExit(err: LinkExitError, metadata: unknown): void;
    onEvent?(eventName: string, metadata: unknown): void;
  }): LinkHandler;
};

export class PlaidClientError extends Error {
  constructor(message: string, public code: string = "error", public status = 0) {
    super(message);
    this.name = "PlaidClientError";
  }
}

export function isReauthError(e: unknown): boolean {
  return e instanceof PlaidClientError && e.code === "reauth";
}

export type PlaidStatus = { configured: boolean; env: "sandbox" | "production" | null };
export type SyncResult = { upserted: number; removed: number; pages: number; hasMore: boolean; historyPending: boolean };
export type ConnectResult = SyncResult & { connectionId: string; institution: string; accounts: number };
type OnStatus = ((message: string) => void) | undefined;

/* ---------------------------------------------------------------- Link loader */

let linkPromise: Promise<PlaidGlobal> | null = null;

function plaidGlobal(): PlaidGlobal | undefined {
  return (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
}

/** Loads Plaid's Link script once per page. */
export function loadPlaidLink(): Promise<PlaidGlobal> {
  if (typeof window === "undefined") return Promise.reject(new PlaidClientError("Bank linking only works in the browser."));
  const ready = plaidGlobal();
  if (ready) return Promise.resolve(ready);
  if (linkPromise) return linkPromise;
  linkPromise = new Promise<PlaidGlobal>((resolve, reject) => {
    const fail = () => {
      linkPromise = null;
      reject(new PlaidClientError("Couldn't load the bank connection window. Check your connection or ad blocker."));
    };
    const done = () => {
      const p = plaidGlobal();
      if (p) resolve(p);
      else fail();
    };
    let script = document.querySelector<HTMLScriptElement>(`script[src="${LINK_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = LINK_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", fail, { once: true });
  });
  return linkPromise;
}

/* ---------------------------------------------------------------- API */

async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new PlaidClientError("You appear to be offline. Try again.", "network");
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!res.ok) {
    const message = typeof data.error === "string" && data.error ? data.error : "Bank sync failed. Try again.";
    const code = typeof data.code === "string" ? data.code : "error";
    throw new PlaidClientError(message, code, res.status);
  }
  return data as T;
}

const ctxBody = (ctx: FinanceContext) => ({ userId: ctx.userId, currency: ctx.currency });

export function getPlaidStatus(): Promise<PlaidStatus> {
  return call<PlaidStatus>("/status");
}

/* ---------------------------------------------------------------- Link */

let linkOpen = false;

/** Opens Link. Resolves the public_token, or null if the user closed it without finishing. */
async function openLink(linkToken: string): Promise<string | null> {
  if (linkOpen) throw new PlaidClientError("The bank connection window is already open.", "busy");
  const Plaid = await loadPlaidLink();
  linkOpen = true;
  return new Promise<string | null>((resolve, reject) => {
    let handler: LinkHandler | null = null;
    const finish = (fn: () => void) => {
      linkOpen = false;
      try {
        handler?.destroy?.();
      } catch {
        /* ignore */
      }
      fn();
    };
    try {
      handler = Plaid.create({
        token: linkToken,
        onSuccess: (publicToken) => finish(() => resolve(publicToken)),
        onExit: (err) =>
          finish(() => {
            // Plain close: not an error. Exit after a Link error (e.g. bank down): surface Plaid's message.
            if (!err || !err.error_code) resolve(null);
            else reject(new PlaidClientError(err.display_message || "Your bank connection didn't finish. Try again later.", err.error_code));
          }),
      });
      handler.open();
    } catch {
      finish(() => reject(new PlaidClientError("Couldn't open the bank connection window.")));
    }
  });
}

/* ---------------------------------------------------------------- flows */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pages /sync until caught up (max 40 pages). Retryable server errors (429/502/503/504) get two short
 * backoffs. If Plaid hasn't started the first pull yet, waits briefly up to `pendingRetries` times.
 */
export async function syncConnection(
  ctx: FinanceContext,
  connectionId: string,
  onStatus?: OnStatus,
  pendingRetries = 0,
): Promise<SyncResult> {
  const total: SyncResult = { upserted: 0, removed: 0, pages: 0, hasMore: true, historyPending: false };
  let waits = 0;
  while (total.hasMore && total.pages < MAX_PAGES) {
    let page!: { upserted: number; removed: number; hasMore: boolean; historyPending?: boolean };
    for (let attempt = 0; ; attempt++) {
      try {
        page = await call("/sync", { ...ctxBody(ctx), connectionId });
        break;
      } catch (e) {
        const retryable = e instanceof PlaidClientError && [429, 502, 503, 504].includes(e.status);
        if (!retryable || attempt >= 2) throw e;
        await sleep(1500 * (attempt + 1));
      }
    }
    total.pages += 1;
    total.upserted += page.upserted;
    total.removed += page.removed;
    total.hasMore = page.hasMore;
    total.historyPending = Boolean(page.historyPending);
    if (total.historyPending && !total.hasMore && waits < pendingRetries) {
      waits += 1;
      onStatus?.("Waiting for your bank to share history…");
      await sleep(3000);
      total.hasMore = true;
      continue;
    }
    onStatus?.(`Synced ${total.upserted} transaction${total.upserted === 1 ? "" : "s"}…`);
  }
  return total;
}

/** Link a new bank: link token -> Link -> exchange -> bootstrap the cursor and backfill. Null if the user closed Link. */
export async function connectBank(ctx: FinanceContext, onStatus?: OnStatus): Promise<ConnectResult | null> {
  onStatus?.("Opening secure bank connection…");
  const [{ linkToken }] = await Promise.all([
    call<{ linkToken: string }>("/link-token", ctxBody(ctx)),
    loadPlaidLink(),
  ]);
  const publicToken = await openLink(linkToken);
  if (!publicToken) return null;

  onStatus?.("Linking accounts…");
  const ex = await call<{ connectionId: string; institution: string; accounts: number }>("/exchange", {
    ...ctxBody(ctx),
    publicToken,
  });

  // Bootstrap the cursor right away: Plaid sends nothing until the first /transactions/sync.
  onStatus?.("Pulling transactions…");
  const synced = await syncConnection(ctx, ex.connectionId, onStatus, 5);
  onStatus?.(synced.historyPending ? `${ex.institution} connected. History is still loading.` : `${ex.institution} connected.`);
  return { ...synced, connectionId: ex.connectionId, institution: ex.institution, accounts: ex.accounts };
}

/** Fix login (Link update mode) for a connection that returned code "reauth", then sync. Null if closed. */
export async function repairConnection(ctx: FinanceContext, connectionId: string, onStatus?: OnStatus): Promise<SyncResult | null> {
  onStatus?.("Opening your bank's sign-in…");
  const [{ linkToken }] = await Promise.all([
    call<{ linkToken: string }>("/link-token", { ...ctxBody(ctx), connectionId }),
    loadPlaidLink(),
  ]);
  const done = await openLink(linkToken);
  if (!done) return null;
  onStatus?.("Login fixed. Syncing…");
  return syncConnection(ctx, connectionId, onStatus);
}
