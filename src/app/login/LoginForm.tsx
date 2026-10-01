"use client";
import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { GitHubLogo, GoogleLogo, LogoMark, Spinner } from "@/components/ui";
import { supabaseBrowser } from "@/lib/supabase/client";

export function LoginForm({ next, initialError, joining }: { next: string; initialError: string | null; joining: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [sent, setSent] = useState(false);

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
      <p className="muted" style={{ margin: 0 }}>
        {joining ? "Your group invite is waiting. Sign in and you'll land right in it." : "Split expenses with your roommates."}
      </p>

      <div className="oauth">
        <button type="button" className="btn" onClick={() => oauth("google")} disabled={!!busy}>
          {busy === "google" ? <Spinner /> : <GoogleLogo />} Continue with Google
        </button>
        <button type="button" className="btn" onClick={() => oauth("github")} disabled={!!busy}>
          {busy === "github" ? <Spinner /> : <GitHubLogo />} Continue with GitHub
        </button>
      </div>

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
      {error && <div className="banner neg" style={{ marginTop: 14 }}>{error}</div>}
      <p className="hint" style={{ marginTop: 22 }}>
        Tip: sign in with the same email your roommates added you with, and you will be connected to their group automatically.
      </p>
    </div>
  );
}
