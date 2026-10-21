"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarDays, Copy, Gauge, LogOut } from "lucide-react";
import { useMe, useToast } from "@/components/providers";
import { Avatar } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api, loadProfile } from "@/lib/data";
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
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div>
          <div className="eyebrow">Signed in as {me.email}</div>
          <h1 className="page-title">Account</h1>
        </div>
      </div>

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
          <button type="button" className="btn btn-danger" onClick={signOut}><LogOut /> Sign out</button>
        </div>
      </section>
    </main>
  );
}

type Kind = "calendar" | "scores";
const LINKS: { kind: Kind; icon: typeof CalendarDays; title: string; body: string }[] = [
  { kind: "calendar", icon: CalendarDays, title: "Reminders in your calendar",
    body: "Group bills you still owe, subscription renewals, card due days and paydays, with an alert at 9am the day before. Subscribe once in Apple, Google or Outlook Calendar; it updates itself." },
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
  const urlFor = (kind: Kind, token: string) => kind === "calendar" ? `${origin}/api/calendar/${token}.ics` : token;

  async function make(kind: Kind) {
    if (status[kind] && !confirm("Make a new link? The old one stops working.")) return;
    try { setFresh({ kind, token: await api.createToken(kind) }); reload(); } catch (e) { toast.err(e); }
  }
  async function off(kind: Kind) {
    if (!confirm("Turn this link off? Anything using it stops updating.")) return;
    try { await api.revokeToken(kind); setFresh(null); reload(); toast.ok("Link turned off"); } catch (e) { toast.err(e); }
  }

  return (
    <section className="card">
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
                  {kind === "calendar"
                    ? <div className="row-flex wrap" style={{ gap: 8 }}><a className="btn btn-sm btn-primary" href={shown.replace(/^https?:/, "webcal:")}>Add to Apple Calendar</a>
                        <a className="btn btn-sm" target="_blank" rel="noreferrer" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(shown.replace(/^https?:/, "webcal:"))}`}>Add to Google Calendar</a></div>
                    : <pre className="small mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{`curl -X POST ${origin}/api/finance/credit-scores/sync \\\n  -H "Authorization: Bearer ${fresh!.token}" -H "content-type: application/json" \\\n  -d '{"scores":[{"bureau":"experian","score":712,"model":"FICO 8","as_of":"2026-10-20"}]}'`}</pre>}
                  <span className="hint">Shown once. Keep it private: anyone with it can {kind === "calendar" ? "read these reminders" : "add scores"}. Make a new link if it leaks.</span>
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
