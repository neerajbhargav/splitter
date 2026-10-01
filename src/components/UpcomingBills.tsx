"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarClock, Check, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { Avatar, Modal, Segmented } from "./ui";
import { useMe, useToast } from "./providers";
import { api } from "@/lib/data";
import { CATEGORIES, category } from "@/lib/categories";
import { centsToInput, longDate, money, todayISO } from "@/lib/format";
import { parseMoney, parseMoneyOrZero, splitEqual } from "@/lib/split";
import type { Group, Member, UpcomingBill } from "@/lib/types";

function dueLabel(b: UpcomingBill): { text: string; tone: "neg" | "gold" | "faint" } {
  if (!b.due_date) return { text: "No due date", tone: "faint" };
  const today = todayISO();
  const days = Math.round((new Date(b.due_date + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 864e5);
  const when = new Date(b.due_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days < 0) return { text: `Overdue since ${when}`, tone: "neg" };
  if (days === 0) return { text: "Due today", tone: "neg" };
  if (days <= 7) return { text: `Due ${when} · in ${days} day${days === 1 ? "" : "s"}`, tone: "gold" };
  return { text: `Due ${when}`, tone: "faint" };
}

export function UpcomingBills({ group, members, bills }: { group: Group; members: Member[]; bills: UpcomingBill[] }) {
  const me = useMe();
  const toast = useToast();
  const mine = members.find((m) => m.user_id === me.id);
  const [open, setOpen] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; bill: UpcomingBill | null }>({ open: false, bill: null });
  const [paying, setPaying] = useState<UpcomingBill | null>(null);
  const cur = group.currency;
  const total = bills.reduce((a, b) => a + b.amount_cents, 0);
  const myTotal = bills.reduce((a, b) => a + (b.upcoming_bill_shares.find((s) => s.member_id === mine?.id)?.amount_cents ?? 0), 0);
  const name = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.user_id === me.id ? "You" : m.display_name) : "Former member";
  };

  return (
    <section className="card upcoming">
      <div className="card-head">
        <span className="card-title row-flex" style={{ gap: 6 }}><CalendarClock width={14} height={14} /> Upcoming bills</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditor({ open: true, bill: null })}><Plus /> Add</button>
      </div>
      <div className="card-body">
        {!bills.length ? (
          <p className="hint" style={{ margin: 0 }}>Nothing coming up. Add a bill before it's paid so everyone sees their share early.</p>
        ) : (
          <>
            <div className="between small" style={{ marginBottom: 4 }}>
              <span className="muted">{bills.length} bill{bills.length === 1 ? "" : "s"} · {money(total, cur)} total</span>
              {mine && <span className="muted">Your part <b className="num" style={{ color: "var(--ink)" }}>{money(myTotal, cur)}</b></span>}
            </div>
            <div className="list">
              {bills.map((b) => {
                const Icon = category(b.category).icon;
                const due = dueLabel(b);
                const myShare = b.upcoming_bill_shares.find((s) => s.member_id === mine?.id)?.amount_cents ?? 0;
                const isOpen = open === b.id;
                const shares = [...b.upcoming_bill_shares].sort((x, y) => y.amount_cents - x.amount_cents);
                return (
                  <div key={b.id}>
                    <div className="item clickable" role="button" tabIndex={0} onClick={() => setOpen(isOpen ? null : b.id)} onKeyDown={(k) => k.key === "Enter" && setOpen(isOpen ? null : b.id)}>
                      <span className="icon-tile"><Icon /></span>
                      <div className="item-main">
                        <div className="item-title row-flex" style={{ gap: 6 }}>
                          <span className="ellipsis">{b.title}</span>
                          {b.is_estimate && <span className="badge" style={{ height: 18 }}>estimate</span>}
                        </div>
                        <div className={`item-sub ${due.tone}`}>{due.text} · {shares.length} people</div>
                      </div>
                      <div className="item-end">
                        <div className="v">{b.is_estimate ? "~" : ""}{money(b.amount_cents, cur)}</div>
                        {mine && <div className="k">you {money(myShare, cur)}</div>}
                      </div>
                      <ChevronDown width={16} className="faint" style={{ transform: isOpen ? "rotate(180deg)" : undefined, transition: "transform .15s", flex: "none" }} />
                    </div>
                    {isOpen && (
                      <div className="upcoming-detail">
                        <div className="list">
                          {shares.map((s) => {
                            const m = members.find((x) => x.id === s.member_id);
                            return (
                              <div key={s.member_id} className="item" style={{ padding: "8px 0" }}>
                                <Avatar name={m?.display_name ?? "?"} color={m?.color} size={24} />
                                <div className="item-main"><span className="item-title" style={{ fontWeight: 400 }}>{name(s.member_id)}</span></div>
                                <span className="num">{money(s.amount_cents, cur)}</span>
                              </div>
                            );
                          })}
                        </div>
                        {b.notes && <p className="small muted" style={{ whiteSpace: "pre-wrap", margin: "10px 0 0" }}>{b.notes}</p>}
                        <div className="row-flex wrap" style={{ marginTop: 12 }}>
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => setPaying(b)}><Check /> Mark as paid</button>
                          <button type="button" className="btn btn-sm" onClick={() => setEditor({ open: true, bill: b })}><Pencil /> Edit</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={async () => {
                            if (!confirm(`Remove "${b.title}" from upcoming bills?`)) return;
                            try { await api.deleteUpcoming(b.id); toast.ok("Removed"); } catch (e) { toast.err(e); }
                          }}><Trash2 /> Remove</button>
                        </div>
                        <p className="hint" style={{ margin: "8px 0 0" }}>Upcoming bills don't change balances. Marking one paid adds it to expenses with this exact split.</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      <UpcomingEditor open={editor.open} bill={editor.bill} group={group} members={members} onClose={() => setEditor({ open: false, bill: null })} />
      <MarkPaid bill={paying} group={group} members={members} onClose={() => setPaying(null)} />
    </section>
  );
}

function UpcomingEditor({ open, bill, group, members, onClose }: {
  open: boolean; bill: UpcomingBill | null; group: Group; members: Member[]; onClose: () => void;
}) {
  const me = useMe();
  const toast = useToast();
  const people = members.filter((m) => m.is_active || bill?.upcoming_bill_shares.some((s) => s.member_id === m.id));
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState("");
  const [estimate, setEstimate] = useState(false);
  const [cat, setCat] = useState("utilities");
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"equal" | "exact">("equal");
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [exact, setExact] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTitle(bill?.title ?? "");
    setAmount(bill ? centsToInput(bill.amount_cents) : "");
    setDue(bill?.due_date ?? "");
    setEstimate(bill?.is_estimate ?? false);
    setCat(bill?.category ?? "utilities");
    setNotes(bill?.notes ?? "");
    if (bill) {
      const amts = bill.upcoming_bill_shares.map((s) => s.amount_cents);
      const even = Math.max(...amts) - Math.min(...amts) <= 1;
      setMode(even ? "equal" : "exact");
      setIncluded(new Set(bill.upcoming_bill_shares.map((s) => s.member_id)));
      setExact(Object.fromEntries(bill.upcoming_bill_shares.map((s) => [s.member_id, centsToInput(s.amount_cents)])));
    } else {
      setMode("equal");
      setIncluded(new Set(members.filter((m) => m.is_active).map((m) => m.id)));
      setExact({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bill]);

  const total = parseMoney(amount) ?? 0;
  const shares = useMemo(() => {
    if (mode === "equal") return splitEqual(total, people.filter((m) => included.has(m.id)).map((m) => m.id)).map((p) => ({ member_id: p.id, amount_cents: p.amount }));
    return people.map((m) => ({ member_id: m.id, amount_cents: parseMoneyOrZero(exact[m.id]) })).filter((s) => s.amount_cents > 0);
  }, [mode, total, people, included, exact]);
  const assigned = shares.reduce((a, s) => a + s.amount_cents, 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Add a name for the bill");
    if (total <= 0) return setError("Enter an amount greater than zero");
    if (!shares.length) return setError("Choose who splits this bill");
    if (assigned !== total) return setError(`Shares add up to ${money(assigned, group.currency)}, the bill is ${money(total, group.currency)}`);
    setBusy(true);
    try {
      await api.saveUpcoming(bill?.id ?? null, group.id, { title: title.trim(), amount_cents: total, due_date: due || null, is_estimate: estimate, category: cat, notes, shares });
      toast.ok(bill ? "Bill updated" : "Upcoming bill added");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={bill ? "Edit upcoming bill" : "Add upcoming bill"} wide
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" form="upcoming-form" className="btn btn-primary" disabled={busy}>{busy ? "Saving..." : "Save"}</button></>}>
      <form id="upcoming-form" onSubmit={submit} className="stack">
        <div className="form-row" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
          <div className="field"><label className="label" htmlFor="ub-title">Bill</label>
            <input id="ub-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Electricity, Wi-Fi, rent..." maxLength={100} /></div>
          <div className="field"><label className="label" htmlFor="ub-cat">Category</label>
            <select id="ub-cat" className="select" value={cat} onChange={(e) => setCat(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select></div>
        </div>
        <div className="form-row" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
          <div className="field"><label className="label" htmlFor="ub-amt">Amount <span className="faint">{group.currency}</span></label>
            <input id="ub-amt" className="input input-lg" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
          <div className="field"><label className="label" htmlFor="ub-due">Due date</label>
            <input id="ub-due" type="date" className="input" style={{ height: 56 }} value={due} onChange={(e) => setDue(e.target.value)} /></div>
        </div>
        <label className="check small"><input type="checkbox" checked={estimate} onChange={(e) => setEstimate(e.target.checked)} /> Amount is an estimate</label>
        <div className="field">
          <div className="between wrap"><span className="label">Split</span>
            <Segmented<"equal" | "exact"> value={mode} onChange={(v) => { setMode(v); if (v === "exact" && !Object.keys(exact).length) setExact(Object.fromEntries(shares.map((s) => [s.member_id, centsToInput(s.amount_cents)]))); }}
              options={[{ id: "equal", label: "Equally" }, { id: "exact", label: "Exact" }]} /></div>
          <div className="card" style={{ padding: "4px 14px", marginTop: 6 }}>
            {people.map((m) => {
              const sh = shares.find((s) => s.member_id === m.id)?.amount_cents ?? 0;
              return (
                <div key={m.id} className={`split-row ${sh ? "" : "off"}`} style={{ gridTemplateColumns: "auto minmax(0,1fr) 110px 80px" }}>
                  <Avatar name={m.display_name} color={m.color} size={24} />
                  <span className="ellipsis">{m.display_name}{m.user_id === me.id && <span className="faint"> (you)</span>}</span>
                  {mode === "equal" ? (
                    <label className="check" style={{ justifySelf: "end" }}><input type="checkbox" checked={included.has(m.id)} aria-label={`Include ${m.display_name}`}
                      onChange={() => setIncluded((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })} /></label>
                  ) : (
                    <input className="input input-sm num" inputMode="decimal" placeholder="0.00" value={exact[m.id] ?? ""} aria-label={`${m.display_name} share`}
                      onChange={(e) => setExact({ ...exact, [m.id]: e.target.value })} />
                  )}
                  <span className="num">{money(sh, group.currency)}</span>
                </div>
              );
            })}
            <div className="split-total" style={{ marginBottom: 10 }}>
              <span className={assigned !== total ? "neg" : "faint"}>{assigned !== total ? `${money(Math.abs(total - assigned), group.currency)} ${total > assigned ? "left to assign" : "over"}` : "Shares add up"}</span>
              <span className="num">{money(assigned, group.currency)} / {money(total, group.currency)}</span>
            </div>
          </div>
        </div>
        <div className="field"><label className="label" htmlFor="ub-notes">Notes</label>
          <textarea id="ub-notes" className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Service period, how the split was worked out..." maxLength={1500} /></div>
        {error && <div className="banner neg">{error}</div>}
      </form>
    </Modal>
  );
}

function MarkPaid({ bill, group, members, onClose }: { bill: UpcomingBill | null; group: Group; members: Member[]; onClose: () => void }) {
  const me = useMe();
  const toast = useToast();
  const people = members.filter((m) => m.is_active);
  const mine = members.find((m) => m.user_id === me.id);
  const [payer, setPayer] = useState("");
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (bill) { setPayer(mine?.id ?? people[0]?.id ?? ""); setDate(todayISO()); setError(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bill]);
  if (!bill) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  return (
    <Modal open={!!bill} onClose={onClose} title="Mark bill as paid"
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !payer} onClick={async () => {
          setBusy(true); setError(null);
          try { await api.markUpcomingPaid(bill.id, [{ member_id: payer, amount_cents: bill.amount_cents }], date); toast.ok(`${bill.title} added to expenses`); onClose(); }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
        }}>{busy ? "Saving..." : `Paid ${money(bill.amount_cents, group.currency)}`}</button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}><b>{bill.title}</b> becomes an expense with the same split{bill.is_estimate ? ". It was an estimate, so edit the amount first if the real bill was different." : "."}</p>
        <div className="form-row">
          <div className="field"><label className="label" htmlFor="mp-payer">Who paid</label>
            <select id="mp-payer" className="select" value={payer} onChange={(e) => setPayer(e.target.value)}>
              {people.map((m) => <option key={m.id} value={m.id}>{m.user_id === me.id ? `${m.display_name} (you)` : m.display_name}</option>)}
            </select></div>
          <div className="field"><label className="label" htmlFor="mp-date">Paid on</label>
            <input id="mp-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        <p className="hint" style={{ margin: 0 }}>Paid on {longDate(date)}. Balances update for everyone right away.</p>
        {error && <div className="banner neg">{error}</div>}
      </div>
    </Modal>
  );
}
