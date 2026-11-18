import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase/env";
import { localDate, planPurchase, purchaseMessage, type PurchaseContext, type PurchaseInput } from "@/lib/purchase-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 4_000;
const reply = (message: string, status = 200, extra: Record<string, unknown> = {}, asJson = false) =>
  asJson
    ? Response.json({ message, ...extra }, { status, headers: { "cache-control": "no-store" } })
    : new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** Shortcuts sends JSON ("Request Body: JSON") or a form; read either. */
async function readBody(req: Request): Promise<PurchaseInput | null> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  const type = req.headers.get("content-type") ?? "";
  if (/json/i.test(type) || /^\s*\{/.test(raw)) {
    try { const v: unknown = JSON.parse(raw || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? (v as PurchaseInput) : null; } catch { return null; }
  }
  return Object.fromEntries(new URLSearchParams(raw)) as PurchaseInput;
}

// POST /api/finance/purchases/<token>?tz=Area/City
// Body: { amount, merchant, card, name?, date? } from the iPhone Shortcuts "Transaction" automation.
// Logs the Apple Pay purchase into Money right away and answers with one line the Shortcut can show,
// e.g. "Logged $4.75 at Starbucks · Coffee". Add ?format=json for JSON. The token in the path is the key;
// make it in SPLITTER > Account > Links for other apps. The database stores only its hash.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const url = new URL(req.url);
  const asJson = url.searchParams.get("format") === "json";
  const token = (await params).token;
  if (!/^[0-9a-f]{64}$/.test(token)) return reply("This Apple Pay link is not valid. Make a new one in SPLITTER > Account.", 404, { code: "unauthorized" }, asJson);
  const input = await readBody(req);
  if (!input) return reply("The Shortcut sent something SPLITTER can't read. Set Request Body to JSON.", 400, { code: "bad_request" }, asJson);

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const ctxRes = await sb.rpc("purchase_context_with_token", { p_token: token });
  if (ctxRes.error) {
    const msg = ctxRes.error.message ?? "";
    if (/turned-off link|invalid/i.test(msg)) return reply("This Apple Pay link was turned off. Make a new one in SPLITTER > Account.", 401, { code: "unauthorized" }, asJson);
    if (/open money/i.test(msg)) return reply("Open Money in SPLITTER once, then try again.", 409, { code: "no_workspace" }, asJson);
    console.error("[purchases] context failed:", msg.slice(0, 120));
    return reply("SPLITTER couldn't log this purchase. Try again.", 502, { code: "db_error" }, asJson);
  }
  const ctx = ctxRes.data as PurchaseContext;
  const plan = planPurchase(input, ctx, localDate(new Date(), url.searchParams.get("tz")));
  if ("error" in plan) return reply(plan.error, 400, { code: "bad_request" }, asJson);

  const { data, error } = await sb.rpc("log_purchase_with_token", { p_token: token, p: plan.row });
  if (error) return reply(String(error.message ?? "SPLITTER couldn't log this purchase.").slice(0, 200), 400, { code: "rejected" }, asJson);
  const result = data as { id: string; duplicate: boolean };
  return reply(purchaseMessage(plan, ctx.currency, result.duplicate), 200,
    { id: result.id, duplicate: result.duplicate, category: plan.category, account: plan.account, how: plan.how, ...plan.row }, asJson);
}
