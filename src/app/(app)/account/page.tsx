"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarDays, Copy, CreditCard, Gauge, LogOut, Trash2 } from "lucide-react";
import { useMe, useToast } from "@/components/providers";
import { Avatar, GitHubLogo, GoogleLogo, Spinner } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api, deleteMyAccount, loadProfile } from "@/lib/data";
import { CURRENCIES, timeAgo } from "@/lib/format";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function AccountPage() {
  const me = useMe();
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState(me.profile?.display_name ?? "");
  const [currency, setCurrency] = useState(me.profile?.default_currency ?? "USD");
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateProfile(name, currency);
      const p = await loadProfile(me.id);
      if (p) me.setProfile(p);
      toast.ok("Profile saved");
    } catch (err) {
      toast.err(err);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (me.guest) {
      if (!confirm("A guest session can't be signed back into. Delete this guest data and sign out? To keep it, use Save your data above.")) return;
      try { await deleteMyAccount(me.id); } catch (e) { toast.err(e); return; }
      await supabaseBrowser().auth.signOut({ scope: "local" });
      router.replace("/login");
      router.refresh();
      return;
    }
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div>
          <div className="eyebrow">{me.guest ? "Guest session" : `Signed in as ${me.email}`}</div>
          <h1 className="page-title">Account</h1>
        </div>
      </div>

      <SaveGuest />

      <form onSubmit={save} className="card">
        <div className="card-body stack">
          <div className="row-flex" style={{ gap: 14 }}>
            <Avatar name={name || "You"} src={me.profile?.avatar_url} size={56} />
            <div className="grow">
              <div className="serif" style={{ fontSize: 24 }}>{me.profile?.display_name || "Your profile"}</div>
              <div className="small faint">{me.email}</div>
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="a-name">Display name</label>
            <input id="a-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            <span className="hint">Shown to everyone in your groups. Saving updates it everywhere.</span>
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label className="label" htmlFor="a-cur">Default currency</label>
            <select id="a-cur" className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving..." : "Save"}</button></div>
        </div>
      </form>

      <section className="card">
        <div className="card-head"><span className="card-title">Appearance</span></div>
        <div className="card-body stack-sm">
          <ThemeToggle />
          <span className="hint">Device follows your phone or computer setting and switches automatically.</span>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><span className="card-title">Use it like an app</span></div>
        <div className="card-body stack-sm muted">
          <p><b className="gold" style={{ fontWeight: 500 }}>iPhone:</b> open SPLITTER in Safari, tap Share, then Add to Home Screen.</p>
          <p><b className="gold" style={{ fontWeight: 500 }}>Android or desktop Chrome:</b> use the Install icon in the address bar.</p>
        </div>
      </section>

      <SecretLinks />

      <section className="card">
        <div className="card-body">
          <button type="button" className="btn btn-danger" onClick={signOut}><LogOut /> {me.guest ? "Delete guest data and sign out" : "Sign out"}</button>
        </div>
      </section>

      <DeleteAccount userId={me.id} email={me.email} />
    </main>
  );
}

type Kind = "calendar" | "scores" | "purchases";
const LINKS: { kind: Kind; icon: typeof CalendarDays; title: string; body: string }[] = [
  { kind: "calendar", icon: CalendarDays, title: "Reminders in your calendar",
    body: "Group bills you still owe, subscription renewals, card due days and paydays, with an alert at 9am the day before. Subscribe once in Apple, Google or Outlook Calendar; it updates itself." },
  { kind: "purchases", icon: CreditCard, title: "Apple Pay logging",
    body: "Every Apple Pay tap on your iPhone goes straight into Money, with the category you used last time at that merchant (or a best guess) and the card's account. Set it up once in the Shortcuts app." },
  { kind: "scores", icon: Gauge, title: "Credit score sync",
    body: "Lets a scheduled job on your own computer post your scores without signing in. It can only add credit scores." },
];

/** Secret links for apps that can't sign in. Each link is shown once; the server keeps only a hash. */
function SecretLinks() {
  const toast = useToast();
  const [status, setStatus] = useState<Record<string, { created_at: string; last_used_at: string | null }>>({});
  const [fresh, setFresh] = useState<{ kind: Kind; token: string } | null>(null);
  const reload = useCallback(() => api.tokenStatus().then(setStatus).catch(() => setStatus({})), []);
  useEffect(() => { reload(); }, [reload]);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const zone = typeof Intl === "undefined" ? "" : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const urlFor = (kind: Kind, token: string) => kind === "calendar" ? `${origin}/api/calendar/${token}.ics`
    : kind === "purchases" ? `${origin}/api/finance/purchases/${token}${zone ? `?tz=${encodeURIComponent(zone)}` : ""}` : token;

  async function make(kind: Kind) {
    if (status[kind] && !confirm("Make a new link? The old one stops working.")) return;
    try { setFresh({ kind, token: await api.createToken(kind) }); reload(); } catch (e) { toast.err(e); }
  }
  async function off(kind: Kind) {
    if (!confirm("Turn this link off? Anything using it stops updating.")) return;
    try { await api.revokeToken(kind); setFresh(null); reload(); toast.ok("Link turned off"); } catch (e) { toast.err(e); }
  }

  return (
    <section className="card" id="links">
      <div className="card-head"><span className="card-title">Links for other apps</span></div>
      <div className="card-body stack">
        {LINKS.map(({ kind, icon: Icon, title, body }) => {
          const s = status[kind];
          const shown = fresh?.kind === kind ? urlFor(kind, fresh.token) : null;
          return (
            <div key={kind} className="stack-sm">
              <div className="row-flex" style={{ gap: 10, alignItems: "flex-start" }}>
                <span className="icon-tile sm"><Icon /></span>
                <div className="grow min0">
                  <div style={{ fontWeight: 500 }}>{title}</div>
                  <div className="hint">{body}</div>
                  <div className="small faint" style={{ marginTop: 2 }}>{s ? `On · made ${timeAgo(s.created_at)}${s.last_used_at ? ` · last used ${timeAgo(s.last_used_at)}` : " · not used yet"}` : "Off"}</div>
                </div>
              </div>
              {shown && (
                <div className="stack-sm">
                  <div className="row-flex">
                    <input className="input mono" readOnly value={shown} onFocus={(e) => e.target.select()} aria-label={`${title} link`} />
                    <button type="button" className="btn btn-icon" style={{ height: 40, width: 40 }} aria-label="Copy" onClick={() => navigator.clipboard.writeText(shown).then(() => toast.ok("Copied"))}><Copy /></button>
                  </div>
                  {kind === "purchases" ? <ApplePaySteps /> : kind === "calendar"
                    ? <div className="row-flex wrap" style={{ gap: 8 }}><a className="btn btn-sm btn-primary" href={shown.replace(/^https?:/, "webcal:")}>Add to Apple Calendar</a>
                        <a className="btn btn-sm" target="_blank" rel="noreferrer" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(shown.replace(/^https?:/, "webcal:"))}`}>Add to Google Calendar</a></div>
                    : <pre className="small mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{`curl -X POST ${origin}/api/finance/credit-scores/sync \\\n  -H "Authorization: Bearer ${fresh!.token}" -H "content-type: application/json" \\\n  -d '{"scores":[{"bureau":"experian","score":712,"model":"FICO 8","as_of":"2026-10-20"}]}'`}</pre>}
                  <span className="hint">Shown once. Keep it private: anyone with it can {kind === "calendar" ? "read these reminders" : kind === "purchases" ? "add purchases to your Money" : "add scores"}. Make a new link if it leaks.</span>
                </div>
              )}
              <div className="row-flex wrap" style={{ gap: 8 }}>
                <button type="button" className="btn btn-sm" onClick={() => make(kind)}>{s ? "Make a new link" : "Make link"}</button>
                {s && <button type="button" className="btn btn-ghost btn-sm" onClick={() => off(kind)}>Turn off</button>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Permanent. Typing the email (or DELETE without one) is the confirmation. */
function DeleteAccount({ userId, email }: { userId: string; email: string | null }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const word = email ?? "DELETE";
  const ready = typed.trim().toLowerCase() === word.toLowerCase();

  async function remove(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await deleteMyAccount(userId);
      await supabaseBrowser().auth.signOut({ scope: "local" });
      router.replace("/login?deleted=1");
      router.refresh();
    } catch (err) {
      toast.err(err);
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head"><span className="card-title">Delete account</span></div>
      <div className="card-body stack-sm">
        <p className="muted">
          Deletes your profile and everything in Money: accounts, transactions, budgets, debts, paychecks, subscriptions,
          credit scores and links for other apps. Groups only you joined are deleted too. In a group others have joined,
          your spot stays with your name so their balances still add up, and its email and phone are removed.
        </p>
        {!open ? (
          <div><button type="button" className="btn btn-danger" onClick={() => setOpen(true)}><Trash2 /> Delete my account</button></div>
        ) : (
          <form onSubmit={remove} className="stack-sm">
            <label className="label" htmlFor="del-confirm">Type {email ? "your email" : "DELETE"} to confirm. This cannot be undone.</label>
            <input id="del-confirm" className="input" autoComplete="off" placeholder={word} value={typed} onChange={(e) => setTyped(e.target.value)} />
            <div className="row-flex wrap" style={{ gap: 8 }}>
              <button type="submit" className="btn btn-danger" disabled={!ready || busy}><Trash2 /> {busy ? "Deleting..." : "Delete permanently"}</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setOpen(false); setTyped(""); }}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

/** The one-time Shortcuts setup for Apple Pay logging, in the order the Shortcuts app asks for things. */
function ApplePaySteps() {
  return (
    <ol className="steps small">
      <li>Copy the link above. On your iPhone, open <b>Shortcuts</b> &gt; <b>Automation</b> &gt; <b>+</b> &gt; <b>Transaction</b>.</li>
      <li>Choose your Wallet cards, pick <b>Run Immediately</b>, then <b>Next</b> &gt; <b>Create New Shortcut</b>.</li>
      <li>Add <b>Get Contents of URL</b> and paste the link. Tap <b>Show More</b>: Method <b>POST</b>, Request Body <b>JSON</b>.</li>
      <li>Add three Text fields: <code>amount</code> = <b>Shortcut Input › Amount</b>, <code>merchant</code> = <b>Shortcut Input › Merchant</b>, <code>card</code> = <b>Shortcut Input › Card or Pass</b>.</li>
      <li>Optional: add <b>Show Notification</b> with <b>Contents of URL</b> to see “Logged $4.75 at Starbucks · Coffee” after each tap.</li>
      <li>Tap <b>Done</b>. Your next Apple Pay tap shows up in Money &gt; Activity. Change a category once and the next tap at that merchant follows it.</li>
    </ol>
  );
}

/**
 * For a guest: connect Google or GitHub to the same account (Supabase linkIdentity), so every group,
 * expense and Money row stays where it is. After a successful link, also shows the confirmation.
 */
function SaveGuest() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(params.get("link_error"));
  const saved = params.get("saved") === "1" && !me.guest;

  // After the redirect back, copy the new name, email and picture into the profile.
  useEffect(() => {
    if (params.get("saved") !== "1") return;
    (async () => {
      await api.ensureProfile().catch(() => {});
      const p = await loadProfile(me.id).catch(() => null);
      if (p) me.setProfile(p);
      router.refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function link(provider: "google" | "github") {
    setBusy(provider);
    setError(null);
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/account?saved=1")}`;
    const { error } = await supabaseBrowser().auth.linkIdentity({ provider, options: { redirectTo } });
    if (error) {
      setError(/manual linking/i.test(error.message) ? "Saving guest data isn't turned on for this copy of SPLITTER yet." : error.message);
      setBusy(null);
    }
  }

  if (saved) return <div className="banner" id="save">Saved. Your data is now on your account, and you can sign in from any device.</div>;
  if (!me.guest) return null;
  return (
    <section className="card card-accent" id="save">
      <div className="card-head"><span className="card-title">Save your data</span></div>
      <div className="card-body stack-sm">
        <p className="muted">
          You&apos;re using SPLITTER as a guest, so this data lives with this browser. Connect Google or GitHub to keep it and sign in
          anywhere. Nothing moves: your groups, expenses and Money stay exactly as they are.
        </p>
        <div className="row-flex wrap" style={{ gap: 8 }}>
          <button type="button" className="btn" disabled={!!busy} onClick={() => link("google")}>{busy === "google" ? <Spinner /> : <GoogleLogo />} Save with Google</button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => link("github")}>{busy === "github" ? <Spinner /> : <GitHubLogo />} Save with GitHub</button>
        </div>
        {error && <div className="banner neg">{error}</div>}
        <span className="hint">Guest data that isn&apos;t opened for 30 days is deleted.</span>
      </div>
    </section>
  );
}
