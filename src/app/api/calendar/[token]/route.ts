import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase/env";
import { buildCalendar, type CalendarFeed } from "@/lib/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/calendar/<token>.ics: the owner's reminder calendar. Calendar apps can't sign in,
// so the secret token in the URL is the key; the database stores only its hash.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.replace(/\.ics$/, "");
  if (!/^[0-9a-f]{64}$/.test(token)) return new Response("Not found", { status: 404 });
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.rpc("calendar_feed", { p_token: token });
  if (error || !data) return new Response("This calendar link was turned off. Make a new one in SPLITTER > Account.", { status: 404 });
  return new Response(buildCalendar(data as CalendarFeed, new Date().toISOString().slice(0, 10)), {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, no-store", "content-disposition": 'inline; filename="splitter.ics"' },
  });
}
