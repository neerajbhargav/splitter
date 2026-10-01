"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, ChevronLeft, Copy, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useMe, useToast } from "@/components/providers";
import { Avatar, Empty, Loading, Switch } from "@/components/ui";
import { api, loadGroup, useLiveRefresh, type GroupBundle } from "@/lib/data";
import { netBalances } from "@/lib/debts";
import { GROUP_KINDS } from "@/lib/categories";
import { CURRENCIES, money } from "@/lib/format";
import { avatarFor } from "@/lib/overview";
import type { GroupKind, Member } from "@/lib/types";

export default function GroupSettings() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const router = useRouter();
  const [b, setB] = useState<GroupBundle | null>(null);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<GroupKind>("home");
  const [currency, setCurrency] = useState("USD");
  const [savingInfo, setSavingInfo] = useState(false);
  const [add, setAdd] = useState({ name: "", email: "", phone: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", email: "", phone: "" });

  const reload = useCallback(async () => {
    try {
      const x = await loadGroup(id);
      setMissing(!x);
      if (x) setB(x);
    } catch (e) {
      toast.err(e);
    }
  }, [id, toast]);
  useEffect(() => {
    reload();
  }, [reload]);
  useLiveRefresh(`settings-${id}`, [{ table: "groups", filter: `id=eq.${id}` }, { table: "group_members", filter: `group_id=eq.${id}` }, { table: "activity", filter: `group_id=eq.${id}` }], reload);
  useEffect(() => {
    if (!b) return;
    setName(b.group.name);
    setKind(b.group.kind);
    setCurrency(b.group.currency);
  }, [b?.group.name, b?.group.kind, b?.group.currency]); // eslint-disable-line react-hooks/exhaustive-deps

  if (missing) return <main className="page page-narrow"><Empty title="Group not found" action={<Link href="/dashboard" className="btn">Dashboard</Link>} /></main>;
  if (!b) return <Loading />;

  const { group, members } = b;
  const net = netBalances(members.map((m) => m.id), b.expenses.filter((e) => !e.deleted_at));
  const mine = members.find((m) => m.user_id === me.id);
  const link = `${window.location.origin}/join/${group.invite_code}`;

  async function saveInfo(e: FormEvent) {
    e.preventDefault();
    setSavingInfo(true);
    try {
      await api.updateGroup(group.id, { name, kind, currency });
      toast.ok("Group updated");
    } catch (err) {
      toast.err(err);
    } finally {
      setSavingInfo(false);
    }
  }

  async function addMember(e: FormEvent) {
    e.preventDefault();
    if (!add.name.trim() && !add.email.trim()) return;
    try {
      await api.addMember(group.id, add.name.trim(), add.email.trim(), add.phone.trim());
      setAdd({ name: "", email: "", phone: "" });
      toast.ok("Added");
    } catch (err) {
      toast.err(err);
    }
  }

  async function saveMember(m: Member) {
    try {
      await api.updateMember(m.id, draft.name, m.user_id ? null : draft.email, draft.phone);
      setEditing(null);
      toast.ok("Saved");
    } catch (err) {
      toast.err(err);
    }
  }

  async function remove(m: Member) {
    if (!confirm(`Remove ${m.display_name} from ${group.name}?`)) return;
    try {
      await api.removeMember(m.id);
      toast.ok(`Removed ${m.display_name}`);
    } catch (err) {
      toast.err(err);
    }
  }

  async function leave() {
    if (!confirm(`Leave ${group.name}? You can rejoin with the invite link.`)) return;
    try {
      await api.leaveGroup(group.id);
      toast.ok(`You left ${group.name}`);
      router.replace("/dashboard");
    } catch (err) {
      toast.err(err);
    }
  }

  async function destroy() {
    const typed = prompt(`This permanently deletes ${group.name} and every expense in it, for everyone. Type the group name to confirm.`);
    if (typed?.trim() !== group.name) return;
    try {
      await api.deleteGroup(group.id);
      toast.ok("Group deleted");
      router.replace("/dashboard");
    } catch (err) {
      toast.err(err);
    }
  }

  return (
    <main className="page page-narrow">
      <Link href={`/groups/${group.id}`} className="back"><ChevronLeft width={14} /> {group.name}</Link>
      <h1 className="page-title">Group settings</h1>

      <form onSubmit={saveInfo} className="card" style={{ marginTop: 24 }}>
        <div className="card-head"><span className="card-title">Details</span></div>
        <div className="card-body stack">
          <div className="field">
            <label className="label" htmlFor="s-name">Name</label>
            <input id="s-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </div>
          <div className="field">
            <span className="label">Type</span>
            <div className="chips">
              {GROUP_KINDS.map((k) => (
                <button type="button" key={k.id} className={`chip plain ${kind === k.id ? "on" : ""}`} onClick={() => setKind(k.id)}><k.icon /> {k.label}</button>
              ))}
            </div>
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label className="label" htmlFor="s-cur">Currency</label>
            <select id="s-cur" className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <span className="hint">Changing this relabels existing amounts. It does not convert them.</span>
          </div>
          <div className="between" style={{ paddingTop: 4 }}>
            <div>
              <div style={{ fontWeight: 500 }}>Simplify debts</div>
              <div className="hint">Settle the group in the fewest payments.</div>
            </div>
            <Switch on={group.simplify_debts} label="Simplify debts" onChange={(v) => api.updateGroup(group.id, { simplify: v }).catch(toast.err)} />
          </div>
          <div><button type="submit" className="btn btn-primary" disabled={savingInfo}>{savingInfo ? "Saving..." : "Save details"}</button></div>
        </div>
      </form>

      <section className="card">
        <div className="card-head"><span className="card-title">Members</span></div>
        <div className="card-body">
          <div className="list">
            {members.filter((m) => m.is_active).map((m) => {
              const bal = net[m.id] ?? 0;
              if (editing === m.id) {
                return (
                  <div key={m.id} className="item wrap" style={{ alignItems: "stretch" }}>
                    <input className="input" style={{ flex: "1 1 140px" }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name" maxLength={40} aria-label="Name" />
                    {!m.user_id && <input className="input" style={{ flex: "1 1 170px" }} type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="Email" aria-label="Email" />}
                    <input className="input" style={{ flex: "1 1 120px" }} type="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="Phone" aria-label="Phone" />
                    <button type="button" className="btn btn-primary btn-icon" style={{ height: 40, width: 40 }} onClick={() => saveMember(m)} aria-label="Save"><Check /></button>
                    <button type="button" className="btn btn-ghost btn-icon" style={{ height: 40, width: 40 }} onClick={() => setEditing(null)} aria-label="Cancel"><X /></button>
                  </div>
                );
              }
              return (
                <div key={m.id} className="item">
                  <Avatar name={m.display_name} color={m.color} src={avatarFor(m, b.profiles)} size={34} />
                  <div className="item-main">
                    <div className="item-title">
                      {m.display_name}
                      {m.user_id === me.id && <span className="faint"> (you)</span>}
                    </div>
                    <div className="item-sub">
                      {[m.user_id ? "Joined" : "Not joined yet", m.email, m.phone].filter(Boolean).join(" · ")}
                      {bal !== 0 && <> · <span className={bal > 0 ? "pos" : "neg"}>{bal > 0 ? "gets back" : "owes"} {money(Math.abs(bal), group.currency)}</span></>}
                    </div>
                  </div>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Edit ${m.display_name}`}
                    onClick={() => { setEditing(m.id); setDraft({ name: m.display_name, email: m.email ?? "", phone: m.phone ?? "" }); }}>
                    <Pencil />
                  </button>
                  {m.id === mine?.id && (
                    <button type="button" className="btn btn-ghost btn-sm" title="You claimed the wrong name? Give it back and pick again." onClick={async () => {
                      if (!confirm(`Give back "${m.display_name}" and pick your name again? Expenses stay with ${m.display_name}.`)) return;
                      try {
                        const code = await api.unclaimMySpot(group.id);
                        router.replace(`/join/${code}?pick=1`);
                      } catch (err) {
                        toast.err(err);
                      }
                    }}>This isn't me</button>
                  )}
                  {m.id !== mine?.id && (
                    <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Remove ${m.display_name}`} onClick={() => remove(m)}
                      disabled={bal !== 0} title={bal !== 0 ? "Settle their balance first" : "Remove"}>
                      <Trash2 />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <form onSubmit={addMember} className="row-flex wrap" style={{ marginTop: 14, alignItems: "stretch" }}>
            <input className="input" style={{ flex: "1 1 140px" }} placeholder="Name" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} maxLength={40} aria-label="New member name" />
            <input className="input" style={{ flex: "1 1 170px" }} type="email" placeholder="Email (optional)" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} aria-label="New member email" />
            <input className="input" style={{ flex: "1 1 120px" }} type="tel" placeholder="Phone (optional)" value={add.phone} onChange={(e) => setAdd({ ...add, phone: e.target.value })} aria-label="New member phone" />
            <button type="submit" className="btn" style={{ height: 40 }}><Plus /> Add</button>
          </form>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><span className="card-title">Invite link</span></div>
        <div className="card-body stack-sm">
          <div className="row-flex">
            <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <button type="button" className="btn btn-icon" style={{ height: 40, width: 40 }} onClick={() => navigator.clipboard.writeText(link).then(() => toast.ok("Link copied"))} aria-label="Copy link"><Copy /></button>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.regenerateInvite(group.id).then(() => toast.ok("New link created")).catch(toast.err)}>
            <RefreshCw /> Reset link (old one stops working)
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><span className="card-title">Danger zone</span></div>
        <div className="card-body row-flex wrap">
          <button type="button" className="btn btn-danger" onClick={leave}>Leave group</button>
          <button type="button" className="btn btn-danger" onClick={destroy}><Trash2 /> Delete group</button>
          <span className="hint">You can only leave or remove people once their balance is zero.</span>
        </div>
      </section>
    </main>
  );
}
