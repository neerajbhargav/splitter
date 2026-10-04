import { type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { HttpError, assertSameOrigin, json, readJsonBody } from "@/lib/plaid-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { scores: [{ bureau, score, model, as_of, source }] } -> { inserted, updated, unchanged }
// Used by the owner's score sync, which reads scores from bureau sites in their own signed-in browser.
// Runs with the caller's Supabase session; the RPC enforces ownership and validates every row.
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const body = await readJsonBody(req);
    if (!Array.isArray(body.scores) || body.scores.length === 0 || body.scores.length > 20) {
      return json({ error: "Send 1 to 20 scores.", code: "bad_request" }, 400);
    }
    const supabase = await supabaseServer();
    const { data: auth, error: authError } = await supabase.auth.getUser();
    const user = auth?.user;
    if (authError || !user) return json({ error: "Sign in to sync your scores.", code: "unauthorized" }, 401);
    const { data: settings, error: settingsError } = await supabase.from("finance_settings").select("currency").eq("user_id", user.id).maybeSingle();
    if (settingsError || !settings?.currency) return json({ error: "Open Finance once before syncing scores.", code: "no_workspace" }, 409);
    const { data, error } = await supabase.rpc("sync_finance_credit_scores", { p_rows: body.scores, p_user: user.id, p_currency: settings.currency });
    if (error) return json({ error: String(error.message ?? "Couldn't save those scores.").slice(0, 200), code: "db_error" }, 400);
    return json(data);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error("[credit-sync] unexpected failure:", e instanceof Error ? e.name : typeof e);
    return json({ error: "Score sync failed. Try again.", code: "server_error" }, 500);
  }
}
