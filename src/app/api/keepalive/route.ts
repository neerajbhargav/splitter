import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daily Vercel cron: one tiny query so the free Supabase project never pauses after a quiet week.
// It reads nothing private (row level security returns no rows without a session).
export async function GET() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await sb.from("groups").select("id", { head: true, count: "exact" }).limit(1);
  return Response.json({ ok: !error }, { status: error ? 503 : 200 });
}
