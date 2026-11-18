"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Mail, UserRound } from "lucide-react";
import { GitHubLogo, GoogleLogo, LogoMark, Spinner } from "@/components/ui";
import { supabaseBrowser } from "@/lib/supabase/client";

// Supabase's built-in mailer only delivers to the project's own team, so email links stay hidden until a
// custom SMTP sender is set up in Supabase and NEXT_PUBLIC_EMAIL_SIGNIN=on is set for the build.
const EMAIL_SIGNIN = process.env.NEXT_PUBLIC_EMAIL_SIGNIN === "on";

export function LoginForm({ next, initialError, joining, deleted = false }: { next: string; initialError: string | null; joining: boolean; deleted?: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [sent, setSent] = useState(false);
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestName, setGuestName] = useState("");

  const callback = () => `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

  async function oauth(provider: "google" | "github") {
    setBusy(provider);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithOAuth({ provider, options: { redirectTo: callback() } });
    if (error) {
      setError(error.message.includes("provider is not enabled") ? `${provider === "google" ? "Google" : "GitHub"} sign-in is not turned on in Supabase yet.` : error.message);
      setBusy(null);
    }
  }

  /** Guest mode: a Supabase anonymous account, saved later by connecting Google or GitHub on Account. */
  async function startGuest(e: FormEvent) {
    e.preventDefault();
    setBusy("guest");
    setError(null);
    const name = guestName.trim().replace(/\s+/g, " ").slice(0, 40) || "Guest";
    const { error } = await supabaseBrowser().auth.signInAnonymously({ options: { data: { name } } });
    if (error) {
      setError(/anonymous/i.test(error.message) ? "Guest mode isn't turned on for this copy of SPLITTER. Sign in with Google or GitHub." : error.message);
      setBusy(null);
      return;
    }
    window.location.assign(next);
  }

  async function magic(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy("email");
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: callback() } });
    setBusy(null);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="auth-card">
      <div className="brand-link" style={{ marginBottom: 36 }}><LogoMark size={30} /><span className="wordmark">SPLIT<b>TER</b></span></div>
      <h2>{joining ? "Sign in to join" : "Sign in"}</h2>
      <p className="muted">
        {joining ? "Your group invite is waiting. Sign in and you'll land right in it." : "Your money in one place, and the costs you share."}
      </p>

      <div className="oauth">
        <button type="button" className="btn" onClick={() => oauth("google")} disabled={!!busy}>
          {busy === "google" ? <Spinner /> : <GoogleLogo />} Continue with Google
        </button>
        <button type="button" className="btn" onClick={() => oauth("github")} disabled={!!busy}>
          {busy === "github" ? <Spinner /> : <GitHubLogo />} Continue with GitHub
        </button>
      </div>

      {guestOpen ? (
        <form onSubmit={startGuest} className="stack-sm guest-start">
          <label className="label" htmlFor="guest-name">What should your groups call you?</label>
          <input id="guest-name" className="input" autoFocus maxLength={40} placeholder="First name (optional)" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
          <button type="submit" className="btn btn-primary btn-block" disabled={!!busy}>{busy === "guest" ? <Spinner /> : <UserRound />} {joining ? "Join as a guest" : "Start as a guest"}</button>
          <span className="hint">No email needed. Your data stays with this browser until you save it with Google or GitHub. Guest data that isn&apos;t opened for 30 days is deleted.</span>
        </form>
      ) : (
        <button type="button" className="btn btn-ghost btn-block guest-link" onClick={() => setGuestOpen(true)} disabled={!!busy}>
          <UserRound /> {joining ? "Join without an account" : "Try it without an account"}
        </button>
      )}

      {EMAIL_SIGNIN && (
        <>
          <div className="or">or</div>
          {sent ? (
            <div className="banner"><Mail /> Check {email} for a sign-in link. You can close this tab.</div>
          ) : (
            <form onSubmit={magic} className="stack-sm">
              <input className="input" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
              <button type="submit" className="btn btn-block" disabled={!!busy}>
                {busy === "email" ? <Spinner /> : <Mail />} Email me a sign-in link
              </button>
            </form>
          )}
        </>
      )}
      {deleted && !error && <div className="banner" style={{ marginTop: 14 }}>Your account was deleted.</div>}
      {error && <div className="banner neg" style={{ marginTop: 14 }}>{error}</div>}
      <p className="hint" style={{ marginTop: 22 }}>
        Tip: sign in with the same email your roommates added you with, and you will be connected to their group automatically.
      </p>
      <p className="hint auth-foot">
        Free and open source, no ads · <a href="https://github.com/neerajbhargav/splitter" target="_blank" rel="noreferrer">GitHub</a> · <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link>
      </p>
    </div>
  );
}
