"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { LogOut } from "lucide-react";
import { useMe, useToast } from "@/components/providers";
import { Avatar } from "@/components/ui";
import { api, loadProfile } from "@/lib/data";
import { CURRENCIES } from "@/lib/format";
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
        <div className="card-head"><span className="card-title">Use it like an app</span></div>
        <div className="card-body stack-sm muted">
          <p style={{ margin: 0 }}><b className="gold" style={{ fontWeight: 500 }}>iPhone:</b> open SPLITTER in Safari, tap Share, then Add to Home Screen.</p>
          <p style={{ margin: 0 }}><b className="gold" style={{ fontWeight: 500 }}>Android or desktop Chrome:</b> use the Install icon in the address bar.</p>
        </div>
      </section>

      <section className="card">
        <div className="card-body">
          <button type="button" className="btn btn-danger" onClick={signOut}><LogOut /> Sign out</button>
        </div>
      </section>
    </main>
  );
}
