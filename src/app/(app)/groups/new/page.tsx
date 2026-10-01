"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ChevronLeft, Plus, X } from "lucide-react";
import { useMe, useToast } from "@/components/providers";
import { GROUP_KINDS } from "@/lib/categories";
import { CURRENCIES } from "@/lib/format";
import { api } from "@/lib/data";
import type { GroupKind } from "@/lib/types";

type Row = { name: string; email: string; phone: string };
const blank = (): Row => ({ name: "", email: "", phone: "" });

export default function NewGroupPage() {
  const me = useMe();
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<GroupKind>("home");
  const [currency, setCurrency] = useState(me.profile?.default_currency ?? "USD");
  const [rows, setRows] = useState<Row[]>([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the group a name");
    setBusy(true);
    setError(null);
    try {
      const people = rows
        .map((r) => ({ name: r.name.trim(), email: r.email.trim(), phone: r.phone.trim() }))
        .filter((r) => r.name || r.email);
      const id = await api.createGroup(name.trim(), kind, currency, people);
      toast.ok(`Created ${name.trim()}`);
      router.push(`/groups/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="page page-narrow">
      <Link href="/groups" className="back"><ChevronLeft width={14} /> Groups</Link>
      <h1 className="page-title">New group</h1>
      <p className="page-sub">You are added automatically. Add everyone else by name, and optionally their email or phone.</p>

      <form onSubmit={submit} className="stack" style={{ marginTop: 24 }}>
        <section className="card">
          <div className="card-body stack">
            <div className="field">
              <label className="label" htmlFor="g-name">Group name</label>
              <input id="g-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Apartment 4B, Montreal trip..." maxLength={60} autoFocus />
            </div>
            <div className="field">
              <span className="label">Type</span>
              <div className="chips">
                {GROUP_KINDS.map((k) => (
                  <button type="button" key={k.id} className={`chip plain ${kind === k.id ? "on" : ""}`} onClick={() => setKind(k.id)}>
                    <k.icon /> {k.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ maxWidth: 220 }}>
              <label className="label" htmlFor="g-cur">Currency</label>
              <select id="g-cur" className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <span className="card-title">People</span>
            <span className="hint">Email links their account when they sign in. Phone enables text reminders.</span>
          </div>
          <div className="card-body stack-sm">
            {rows.map((r, i) => (
              <div key={i} className="row-flex wrap" style={{ alignItems: "stretch" }}>
                <input className="input" style={{ flex: "1 1 150px" }} placeholder="Name" value={r.name} onChange={(e) => set(i, { name: e.target.value })} maxLength={40} aria-label={`Person ${i + 1} name`} />
                <input className="input" style={{ flex: "1 1 180px" }} type="email" placeholder="Email (optional)" value={r.email} onChange={(e) => set(i, { email: e.target.value })} aria-label={`Person ${i + 1} email`} />
                <input className="input" style={{ flex: "1 1 130px" }} type="tel" placeholder="Phone (optional)" value={r.phone} onChange={(e) => set(i, { phone: e.target.value })} aria-label={`Person ${i + 1} phone`} />
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove row" style={{ height: 40 }}>
                  <X />
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost" onClick={() => setRows([...rows, blank()])}><Plus /> Add another person</button>
          </div>
        </section>

        {error && <div className="banner neg">{error}</div>}
        <div className="row-flex">
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>{busy ? "Creating..." : "Create group"}</button>
          <Link href="/groups" className="btn btn-ghost btn-lg">Cancel</Link>
        </div>
      </form>
    </main>
  );
}
