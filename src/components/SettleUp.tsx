"use client";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, ArrowRightLeft } from "lucide-react";
import { Avatar, Modal } from "./ui";
import { useMe, useToast } from "./providers";
import { api } from "@/lib/data";
import { centsToInput, money, todayISO } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import type { Tx } from "@/lib/debts";
import type { Expense, Group, Member } from "@/lib/types";

export function SettleUpModal({ open, onClose, group, members, debts, preset, payment }: {
  open: boolean;
  onClose: () => void;
  group: Group;
  members: Member[];
  debts: Tx[];
  preset?: Tx | null;
  payment?: Expense | null;
}) {
  const me = useMe();
  const toast = useToast();
  const mine = members.find((m) => m.user_id === me.id);
  const people = members.filter((m) => m.is_active || m.id === payment?.expense_payers[0]?.member_id || m.id === payment?.expense_splits[0]?.member_id);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (payment) {
      setFrom(payment.expense_payers[0]?.member_id ?? "");
      setTo(payment.expense_splits[0]?.member_id ?? "");
      setAmount(centsToInput(payment.amount_cents));
      setDate(payment.expense_date);
      setNotes(payment.notes ?? "");
      return;
    }
    const pick = preset ?? debts.find((d) => d.from === mine?.id) ?? debts.find((d) => d.to === mine?.id) ?? debts[0];
    setFrom(pick?.from ?? mine?.id ?? people[0]?.id ?? "");
    setTo(pick?.to ?? people.find((m) => m.id !== (pick?.from ?? mine?.id))?.id ?? "");
    setAmount(pick ? centsToInput(pick.amount) : "");
    setDate(todayISO());
    setNotes("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payment, preset]);

  const name = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? (m.user_id === me.id ? "You" : m.display_name) : "Someone";
  };
  const owed = debts.find((d) => d.from === from && d.to === to);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = parseMoney(amount) ?? 0;
    if (!from || !to) return setError("Choose who paid and who received it");
    if (from === to) return setError("Pick two different people");
    if (cents <= 0) return setError("Enter an amount greater than zero");
    setSaving(true);
    try {
      await api.saveExpense(payment?.id ?? null, group.id, {
        description: "Payment",
        amount_cents: cents,
        category: "payment",
        expense_date: date,
        notes,
        split_type: "exact",
        is_payment: true,
        repeat_interval: "none",
        payers: [{ member_id: from, amount_cents: cents }],
        splits: [{ member_id: to, amount_cents: cents }],
      });
      toast.ok(`${name(from)} paid ${name(to)} ${money(cents, group.currency)}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={payment ? "Edit payment" : "Settle up"}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="settle-form" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving..." : "Record payment"}
          </button>
        </>
      }
    >
      <form id="settle-form" onSubmit={submit} className="stack">
        {!payment && debts.length > 0 && (
          <div className="field">
            <span className="label">Suggested</span>
            <div className="card" style={{ padding: "2px 14px" }}>
              {debts.slice(0, 6).map((d) => {
                const a = members.find((m) => m.id === d.from);
                const b = members.find((m) => m.id === d.to);
                const on = d.from === from && d.to === to;
                return (
                  <button type="button" key={d.from + d.to} className="debt" style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid var(--line)", cursor: "pointer", textAlign: "left", color: "inherit" }}
                    onClick={() => { setFrom(d.from); setTo(d.to); setAmount(centsToInput(d.amount)); }}>
                    <Avatar name={a?.display_name ?? "?"} color={a?.color} size={24} />
                    <span className="grow ellipsis">
                      <b style={{ fontWeight: 500 }}>{name(d.from)}</b> <span className="faint">pays</span> <b style={{ fontWeight: 500 }}>{name(d.to)}</b>
                    </span>
                    <Avatar name={b?.display_name ?? "?"} color={b?.color} size={24} />
                    <span className={`num ${on ? "gold" : ""}`} style={{ minWidth: 84, textAlign: "right" }}>{money(d.amount, group.currency)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="row-flex" style={{ alignItems: "flex-end" }}>
          <div className="field grow">
            <label className="label" htmlFor="pay-from">Paid by</label>
            <select id="pay-from" className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
              {people.map((m) => <option key={m.id} value={m.id}>{m.user_id === me.id ? `${m.display_name} (you)` : m.display_name}</option>)}
            </select>
          </div>
          <button type="button" className="btn btn-icon" aria-label="Swap" title="Swap" onClick={() => { setFrom(to); setTo(from); }}>
            <ArrowRightLeft />
          </button>
          <div className="field grow">
            <label className="label" htmlFor="pay-to">Paid to</label>
            <select id="pay-to" className="select" value={to} onChange={(e) => setTo(e.target.value)}>
              {people.map((m) => <option key={m.id} value={m.id}>{m.user_id === me.id ? `${m.display_name} (you)` : m.display_name}</option>)}
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label className="label" htmlFor="pay-amt">Amount <span className="faint">{group.currency}</span></label>
            <input id="pay-amt" className="input input-lg" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div className="field">
            <label className="label" htmlFor="pay-date">Date</label>
            <input id="pay-date" type="date" className="input" style={{ height: 56 }} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        {owed && !payment && (
          <div className="hint row-flex">
            {name(from)} <ArrowRight width={12} /> {name(to)}: {money(owed.amount, group.currency)} outstanding.
            {parseMoney(amount) !== owed.amount && (
              <button type="button" className="link-btn" onClick={() => setAmount(centsToInput(owed.amount))}>Pay in full</button>
            )}
          </div>
        )}
        <div className="field">
          <label className="label" htmlFor="pay-notes">Note</label>
          <input id="pay-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Zelle, Venmo, cash..." maxLength={200} />
        </div>
        <p className="hint" style={{ margin: 0 }}>This records a payment that already happened outside SPLITTER. No money moves.</p>
        {error && <div className="banner neg">{error}</div>}
      </form>
    </Modal>
  );
}
