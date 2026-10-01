import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

// OAuth and email-link sign-ins land here with a one-time code that we swap for a session cookie.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawNext = url.searchParams.get("next") ?? "/dashboard";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";
  // Behind Vercel's proxy, rebuild the public origin from the forwarded headers.
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0] ?? url.protocol.replace(":", "");
  const base = `${proto}://${host}`;

  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) {
    return NextResponse.redirect(`${base}/login?error=${encodeURIComponent(providerError)}&next=${encodeURIComponent(next)}`);
  }
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${base}${next}`);
    return NextResponse.redirect(`${base}/login?error=${encodeURIComponent(error.message)}&next=${encodeURIComponent(next)}`);
  }
  return NextResponse.redirect(`${base}/login?error=${encodeURIComponent("Sign-in link was missing a code. Try again.")}`);
}
