"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Modal, Spinner, Switch } from "@/components/ui";
import { useToast } from "@/components/providers";
import { centsToInput, money } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { FINANCE_MAX_CENTS, type DebtPlanInput, type DebtPlanSettings, type FinanceContext } from "@/lib/finance-types";
import type { DebtPlannerDebt } from "@/lib/debt-planner";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { MoneyInput, errorText, monthShort, useDraftContext } from "./kit";

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

type ChangeRow = { key: string; month: string; amount: string };
type LumpRow = { key: string; id?: string; month: string; amount: string; target: string; note: string };
type PayRow = { amount: string; due: string };

let seq = 0;
const key = () => `r${++seq}`;

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

function validMonth(m: string): boolean {
  const match = MONTH_RE.exec(m);
  return !!match && Number(match[1]) >= 1900 && Number(match[1]) <= 2200;
}

/** Sorts debts by a saved custom order; unlisted debts keep their input order at the end. */
export function orderDebts(debts: readonly DebtPlannerDebt[], priority: readonly string[]): DebtPlannerDebt[] {
  const rank = (id: string) => { const i = priority.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return debts.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d.id) - rank(b.d.id) || a.i - b.i).map((x) => x.d);
}

/** Edit the custom payoff plan: order, amounts, due days, rollover, scheduled changes and one-time payments. */
export function DebtPlanEditor({ open, plan, debts, strategy, extraCents, onSave, onClose }: {
  open: boolean;
  plan: Pick<DebtPlanSettings, "strategy" | "rollover" | "priority" | "payments" | "extra_changes" | "lump_sums"> | null;
  debts: DebtPlannerDebt[];
  /** Strategy and extra currently on screen, kept when saving. */
  strategy: DebtPlanSettings["strategy"];
  extraCents: number;
  /** Applies the plan on the page and saves it. Resolves to a message to show, or null when saved. */
  onSave: (input: DebtPlanInput, context: FinanceContext) => Promise<string | null>;
  onClose: () => void;
}) {
  const { currency, today } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const cur = draft.captured?.currency ?? currency;
  const month = today.slice(0, 7);

  const [useCustom, setUseCustom] = useState(true);
  const [order, setOrder] = useState<string[]>([]);
  const [pays, setPays] = useState<Record<string, PayRow>>({});
  const [rollover, setRollover] = useState(true);
  const [changes, setChanges] = useState<ChangeRow[]>([]);
  const [lumps, setLumps] = useState<LumpRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) { draft.release(); return; }
    // Editing order or amounts usually means you want them used, so this starts on.
    setUseCustom(true);
    setOrder(orderDebts(debts, plan?.priority ?? []).map((d) => d.id));
    const p: Record<string, PayRow> = {};
    for (const d of debts) {
      const saved = plan?.payments.find((x) => x.account_id === d.id);
      p[d.id] = { amount: saved?.monthly_cents ? centsToInput(saved.monthly_cents) : "", due: saved?.due_day ? String(saved.due_day) : "" };
    }
    setPays(p);
    setRollover(plan?.rollover ?? true);
    setChanges((plan?.extra_changes ?? []).map((c) => ({ key: key(), month: c.month, amount: centsToInput(c.extra_monthly_cents) })));
    setLumps((plan?.lump_sums ?? []).map((l) => ({ key: key(), id: l.id, month: l.month, amount: centsToInput(l.amount_cents), target: l.account_id ?? "", note: l.note })));
    setError(null);
    setTried(false);
    draft.capture();
    // Reset only when the dialog opens; live reloads must not rewrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const byId = useMemo(() => new Map(debts.map((d) => [d.id, d])), [debts]);
  const ordered = order.map((id) => byId.get(id)).filter((d): d is DebtPlannerDebt => !!d);

  const move = (i: number, delta: number) => setOrder((o) => {
    const j = i + delta;
    if (j < 0 || j >= o.length) return o;
    const next = [...o];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  // ---------- validation (exact cents) ----------
  const payErrors: Record<string, string> = {};
  for (const d of debts) {
    const t = pays[d.id]?.amount.trim() ?? "";
    if (!t) continue;
    const c = parseMoney(t);
    if (c === null || c < 1 || c > FINANCE_MAX_CENTS) payErrors[d.id] = "Enter an amount like 250 or 125.50.";
  }
  const seen = new Set<string>();
  const changeErrors: Record<string, string> = {};
  for (const r of changes) {
    if (!validMonth(r.month)) { changeErrors[r.key] = "Pick a month."; continue; }
    if (seen.has(r.month)) { changeErrors[r.key] = "You already have a change that month."; continue; }
    seen.add(r.month);
    const c = parseMoney(r.amount.trim() || "0");
    if (c === null || c < 0 || c > FINANCE_MAX_CENTS) changeErrors[r.key] = "Enter an amount, or 0 to stop paying extra.";
  }
  const lumpErrors: Record<string, string> = {};
  for (const r of lumps) {
    if (!validMonth(r.month)) { lumpErrors[r.key] = "Pick a month."; continue; }
    const c = parseMoney(r.amount);
    if (c === null || c < 1 || c > FINANCE_MAX_CENTS) lumpErrors[r.key] = "Enter an amount like 600.";
    else if (r.note.length > 80) lumpErrors[r.key] = "Keep the note under 81 characters.";
  }
  const hasErrors = Object.keys(payErrors).length + Object.keys(changeErrors).length + Object.keys(lumpErrors).length > 0;

  async function save() {
    setTried(true);
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    if (hasErrors) return setError("Fix the highlighted fields first.");
    const input: DebtPlanInput = {
      strategy: useCustom ? "custom" : strategy !== "custom" ? strategy : "avalanche",
      extra_monthly_cents: extraCents,
      rollover,
      priority: order,
      payments: debts.map((d) => ({
        account_id: d.id,
        monthly_cents: pays[d.id]?.amount.trim() ? parseMoney(pays[d.id].amount)! : null,
        due_day: pays[d.id]?.due ? Number(pays[d.id].due) : null,
      })).filter((p) => p.monthly_cents !== null || p.due_day !== null),
      extra_changes: changes.map((r) => ({ month: r.month, extra_monthly_cents: parseMoney(r.amount.trim() || "0")! })),
      lump_sums: lumps.map((r) => ({ id: r.id, month: r.month, account_id: r.target || null, amount_cents: parseMoney(r.amount)!, note: r.note.trim() })),
    };
    setBusy(true);
    setError(null);
    try {
      const note = await onSave(input, draft.captured);
      if (note) toast.err(new Error(note)); else toast.ok("Payment plan saved");
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const show = (m: Record<string, string>, k: string) => (tried || m[k] ? m[k] : undefined);

  return (
    <Modal open={open} wide onClose={() => { if (!busy) onClose(); }} title="Your payment plan"
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="fin-debtplan-form" className="btn btn-primary" disabled={busy || draft.stale}>{busy && <Spinner />}Save plan</button>
      </>}>
      <form id="fin-debtplan-form" className="stack fin-plan-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="row-flex fin-plan-toggle">
          <span className="min0">
            <span style={{ display: "block", fontWeight: 500 }}>Use this as my plan</span>
            <span className="hint" style={{ display: "block" }}>Switches the Debt page to Custom. Turn off to keep comparing Avalanche and Snowball.</span>
          </span>
          <Switch on={useCustom} onChange={setUseCustom} label="Use this as my plan" />
        </label>

        <section className="fin-plan-sec">
          <h3>Payoff order</h3>
          <p className="hint">Extra money goes to the top debt first. Only the Custom plan uses this order.</p>
          <ol className="fin-plan-order">
            {ordered.map((d, i) => (
              <li key={d.id}>
                <span className="icon-tile sm"><b>{i + 1}</b></span>
                <span className="min0 fin-plan-name">{d.name}<span className="hint num">{money(d.balance_cents, cur)} · {(d.apr_bps / 100).toFixed(2).replace(/\.00$/, "")}%</span></span>
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${d.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></button>
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${d.name} down`} disabled={i === ordered.length - 1} onClick={() => move(i, 1)}><ArrowDown /></button>
              </li>
            ))}
          </ol>
        </section>

        <section className="fin-plan-sec">
          <h3>Monthly payment per debt</h3>
          <p className="hint">Leave blank to pay the minimum. Due days help the paycheck planner put each payment in the right paycheck.</p>
          {ordered.map((d) => {
            const row = pays[d.id] ?? { amount: "", due: "" };
            const c = parseMoney(row.amount);
            const below = row.amount.trim() !== "" && c !== null && c >= 1 && c < d.minimum_cents;
            const err = show(payErrors, d.id);
            return (
              <div key={d.id} className="fin-plan-pay">
                <div className="field">
                  <label className="label" htmlFor={`fin-plan-amt-${d.id}`}>{d.name}</label>
                  <MoneyInput id={`fin-plan-amt-${d.id}`} currency={cur} value={row.amount} placeholder={centsToInput(d.minimum_cents)}
                    onChange={(v) => setPays((p) => ({ ...p, [d.id]: { ...row, amount: v } }))} />
                  {err ? <span className="hint neg">{err}</span>
                    : below ? <span className="hint">Raised to the {money(d.minimum_cents, cur)} minimum</span> : null}
                </div>
                <div className="field">
                  <label className="label" htmlFor={`fin-plan-due-${d.id}`}>Due day</label>
                  <select id={`fin-plan-due-${d.id}`} className="select" value={row.due} onChange={(e) => setPays((p) => ({ ...p, [d.id]: { ...row, due: e.target.value } }))}>
                    <option value="">Not set</option>
                    {DAYS.map((n) => <option key={n} value={n}>{n === 31 ? "31 (last day)" : ordinal(n)}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
          <p className="hint">31 means the last day of the month, so short months still work.</p>
        </section>

        <label className="row-flex fin-plan-toggle">
          <span className="min0">
            <span style={{ display: "block", fontWeight: 500 }}>Roll payments forward</span>
            <span className="hint" style={{ display: "block" }}>When a debt is paid off, roll its payment into the next one.</span>
          </span>
          <Switch on={rollover} onChange={setRollover} label="When a debt is paid off, roll its payment into the next one" />
        </label>

        <section className="fin-plan-sec">
          <h3>Scheduled changes</h3>
          <p className="hint">Got a raise coming, or a bill ending? From that month, your extra amount changes. Applies to every strategy.</p>
          {changes.map((r) => {
            const err = show(changeErrors, r.key);
            return (
              <div key={r.key} className="fin-plan-row">
                <div className="field">
                  <label className="label" htmlFor={`fin-plan-cm-${r.key}`}>From</label>
                  <input id={`fin-plan-cm-${r.key}`} className="input" type="month" min="1900-01" max="2200-12" value={r.month}
                    onChange={(e) => setChanges((list) => list.map((x) => (x.key === r.key ? { ...x, month: e.target.value } : x)))} />
                </div>
                <div className="field">
                  <label className="label" htmlFor={`fin-plan-ca-${r.key}`}>Pay extra each month</label>
                  <MoneyInput id={`fin-plan-ca-${r.key}`} currency={cur} value={r.amount}
                    onChange={(v) => setChanges((list) => list.map((x) => (x.key === r.key ? { ...x, amount: v } : x)))} />
                </div>
                <button type="button" className="btn btn-ghost btn-icon fin-plan-del" aria-label="Remove this change" onClick={() => setChanges((list) => list.filter((x) => x.key !== r.key))}><Trash2 /></button>
                {err && <span className="hint neg fin-plan-err">{err}</span>}
                {!err && validMonth(r.month) && r.month <= month && <span className="hint fin-plan-err">Already in effect.</span>}
              </div>
            );
          })}
          <button type="button" className="btn btn-sm fin-plan-add" onClick={() => setChanges((l) => [...l, { key: key(), month: nextMonth(month), amount: "" }])}><Plus /> Add a change</button>
        </section>

        <section className="fin-plan-sec">
          <h3>One-time payments</h3>
          <p className="hint">A tax refund, a bonus, money from selling something. Applies to every strategy.</p>
          {lumps.map((r) => {
            const err = show(lumpErrors, r.key);
            const past = validMonth(r.month) && r.month < month;
            return (
              <div key={r.key} className="fin-plan-lump">
                <div className="fin-plan-row">
                  <div className="field">
                    <label className="label" htmlFor={`fin-plan-lm-${r.key}`}>Month</label>
                    <input id={`fin-plan-lm-${r.key}`} className="input" type="month" min="1900-01" max="2200-12" value={r.month}
                      onChange={(e) => setLumps((list) => list.map((x) => (x.key === r.key ? { ...x, month: e.target.value } : x)))} />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor={`fin-plan-la-${r.key}`}>Amount</label>
                    <MoneyInput id={`fin-plan-la-${r.key}`} currency={cur} value={r.amount}
                      onChange={(v) => setLumps((list) => list.map((x) => (x.key === r.key ? { ...x, amount: v } : x)))} />
                  </div>
                  <button type="button" className="btn btn-ghost btn-icon fin-plan-del" aria-label="Remove this payment" onClick={() => setLumps((list) => list.filter((x) => x.key !== r.key))}><Trash2 /></button>
                </div>
                <div className="form-row">
                  <div className="field">
                    <label className="label" htmlFor={`fin-plan-lt-${r.key}`}>Put it toward</label>
                    <select id={`fin-plan-lt-${r.key}`} className="select" value={r.target} onChange={(e) => setLumps((list) => list.map((x) => (x.key === r.key ? { ...x, target: e.target.value } : x)))}>
                      <option value="">Follow payoff order</option>
                      {ordered.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      {r.target && !byId.has(r.target) && <option value={r.target}>A debt you removed</option>}
                    </select>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor={`fin-plan-ln-${r.key}`}>Note</label>
                    <input id={`fin-plan-ln-${r.key}`} className="input" maxLength={80} placeholder="Tax refund" value={r.note}
                      onChange={(e) => setLumps((list) => list.map((x) => (x.key === r.key ? { ...x, note: e.target.value } : x)))} />
                  </div>
                </div>
                {err ? <span className="hint neg">{err}</span> : past ? <span className="hint">{monthShort(r.month)} has passed, so the plan skips this one.</span> : null}
              </div>
            );
          })}
          <button type="button" className="btn btn-sm fin-plan-add" onClick={() => setLumps((l) => [...l, { key: key(), month: nextMonth(month), amount: "", target: "", note: "" }])}><Plus /> Add a one-time payment</button>
        </section>

        {draft.stale && <div className="banner neg">{STALE_DRAFT}</div>}
        {error && <div className="banner neg" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
