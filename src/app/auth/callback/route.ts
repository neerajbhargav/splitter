import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

// OAuth and email-link sign-ins land here with a one-time code that we swap for a session cookie.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawNext = url.searchParams.get("next") ?? "/finance";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/finance";
  // Behind Vercel's proxy, rebuild the public origin from the forwarded headers.
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0] ?? url.protocol.replace(":", "");
  const base = `${proto}://${host}`;

  const supabase = await supabaseServer();
  // A guest connecting Google or GitHub (linkIdentity) still has their session when this fails, and the
  // sign-in page would bounce them straight back into the app, so their errors go to Account instead.
  const fail = async (message: string) => {
    const { data } = await supabase.auth.getUser();
    if (data.user) return NextResponse.redirect(`${base}/account?link_error=${encodeURIComponent(linkMessage(message))}#save`);
    return NextResponse.redirect(`${base}/login?error=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`);
  };
  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) return fail(providerError);
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${base}${next}`);
    return fail(error.message);
  }
  return NextResponse.redirect(`${base}/login?error=${encodeURIComponent("Sign-in link was missing a code. Try again.")}`);
}

function linkMessage(message: string): string {
  if (/already (been )?linked|identity_already_exists|already exists/i.test(message)) {
    return "That account already has its own SPLITTER account, so this guest data can't be added to it. Connect a different one, or keep using this guest session.";
  }
  if (/manual linking is disabled/i.test(message)) return "Saving guest data isn't turned on for this copy of SPLITTER yet.";
  return message;
}
