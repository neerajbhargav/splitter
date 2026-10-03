"use client";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Ban, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { Modal, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { centsToInput, money } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { addCalendarDays, nextRenewalDate, renewalDatesInWindow, subscriptionEquivalent } from "@/lib/subscription-planner";
import { FINANCE_MAX_CENTS, type Subscription, type SubscriptionCycle, type SubscriptionStatus } from "@/lib/finance-types";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { MoneyInput, errorText, relativeDay, shortDay, useDraftContext } from "./kit";

const CYCLE_LABEL: Record<SubscriptionCycle, string> = { weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };

function lastDue(s: Subscription, today: string): string {
  const span = s.cycle === "weekly" ? 7 : s.cycle === "monthly" ? 31 : s.cycle === "quarterly" ? 92 : 366;
  const start = addCalendarDays(today, -(span - 1)) ?? today;
  return renewalDatesInWindow(s.anchor_date, s.cycle, start, today).at(-1) ?? today;
}

type ManageRow = { key: string; label: string; sub: string; icon: ComponentType; run: () => void; danger?: boolean };

/** One subscription: facts, log a charge, pause, cancel, delete. */
export function SubscriptionSheet({ open, subscription, onClose, onEdit }: {
  open: boolean; subscription: Subscription | null; onClose: () => void; onEdit: (s: Subscription) => void;
}) {
  const { bundle, currency, today, api } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const [logging, setLogging] = useState(false);
  const [logDate, setLogDate] = useState(today);
  const [logAmount, setLogAmount] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const s = bundle.subscriptions.find((x) => x.id === subscription?.id) ?? subscription;

  useEffect(() => {
    if (!open) { draft.release(); return; }
    setLogging(false);
    setConfirmDelete(false);
    setError(null);
    setBusy(false);
    if (subscription) {
      const live = bundle.subscriptions.find((x) => x.id === subscription.id) ?? subscription;
      setLogDate(lastDue(live, today));
      setLogAmount(centsToInput(live.amount_cents));
    }
    draft.capture();
    // Only reset when the dialog opens or switches entity; live reloads must not rewrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subscription?.id]);

  const lastLogged = useMemo(() => {
    if (!s) return null;
    let latest: string | null = null;
    for (const t of bundle.transactions) if (t.subscription_id === s.id && (latest === null || t.date > latest)) latest = t.date;
    return latest;
  }, [bundle.transactions, s]);

  if (!s) return null;
  const sub = s;
  const category = bundle.categories.find((c) => c.id === sub.category_id);
  const account = bundle.accounts.find((a) => a.id === sub.account_id);
  const next = sub.status === "active" ? nextRenewalDate(sub.anchor_date, sub.cycle, today) : null;
  const eq = subscriptionEquivalent(sub.amount_cents, sub.cycle);
  const cur = draft.captured?.currency ?? currency;

  async function setStatus(status: SubscriptionStatus, done: string) {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    setBusy(true);
    setError(null);
    try {
      await api.saveSubscription({
        id: sub.id, name: sub.name, amount_cents: sub.amount_cents, cycle: sub.cycle, anchor_date: sub.anchor_date, status,
        notes: sub.notes, category_id: sub.category_id, account_id: sub.account_id,
      }, draft.captured);
      toast.ok(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    setBusy(true);
    setError(null);
    try {
      await api.deleteSubscription(sub.id, draft.captured);
      toast.ok("Subscription deleted");
      onClose();
    } catch (e) {
      setError(errorText(e));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  const logCents = parseMoney(logAmount);

  async function logCharge() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    if (!logDate || logDate > today) return setError("Pick a date that has already happened.");
    if (bundle.transactions.some((t) => t.subscription_id === sub.id && t.date === logDate)) return setError(`Already logged for ${shortDay(logDate)}.`);
    if (logCents === null || logCents <= 0 || logCents > FINANCE_MAX_CENTS) return setError("Enter an amount greater than zero.");
    setBusy(true);
    setError(null);
    try {
      await api.saveTransaction({
        kind: "expense", amount_cents: logCents, description: sub.name, date: logDate,
        category_id: sub.category_id, account_id: sub.account_id, subscription_id: sub.id,
      }, draft.captured);
      toast.ok(`Logged ${money(logCents, cur)} for ${sub.name}`);
      setLogging(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const manage: ManageRow[] = [];
  if (sub.status === "active") manage.push({ key: "pause", label: "Pause", sub: "Stop counting it until you resume.", icon: Pause, run: () => void setStatus("paused", "Paused") });
  if (sub.status === "paused") manage.push({ key: "resume", label: "Resume", sub: "Count it again from the next billing date.", icon: Play, run: () => void setStatus("active", "Resumed") });
  if (sub.status === "canceled") manage.push({ key: "reactivate", label: "Reactivate", sub: "Start tracking renewals again.", icon: RotateCcw, run: () => void setStatus("active", "Reactivated") });
  if (sub.status !== "canceled") manage.push({ key: "cancel", label: "Mark as canceled", sub: `Use this after you cancel with ${sub.name}. It doesn't cancel it for you.`, icon: Ban, run: () => void setStatus("canceled", "Marked as canceled") });
  manage.push({ key: "delete", label: "Delete", sub: "Removes it from this list. Charges you logged stay in Activity.", icon: Trash2, danger: true, run: () => setConfirmDelete(true) });

  const canLog = sub.status !== "canceled";
  const footer = confirmDelete ? (
    <>
      <span className="hint" style={{ marginRight: "auto" }}>Delete this subscription?</span>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</button>
      <button type="button" className="btn btn-danger" disabled={busy || draft.stale} onClick={() => void remove()}>{busy && <Spinner />}Delete</button>
    </>
  ) : (
    <>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onEdit(sub)}>Edit</button>
      {canLog ? (
        <button type="button" className="btn btn-primary" disabled={busy || logging} onClick={() => { setError(null); setLogging(true); }}>Log charge</button>
      ) : (
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      )}
    </>
  );

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={sub.name} footer={footer}>
      <div className="stack">
        <div className="fin-sheet-head">
          <span className="serif num">{money(sub.amount_cents, cur)}</span>
          <span className="muted">{CYCLE_LABEL[sub.cycle]}</span>
        </div>
        <dl className="fin-facts">
          <dt>Next charge</dt>
          <dd>{sub.status === "active" ? (next ? `${shortDay(next)} · ${relativeDay(next, today)}` : "Not set") : sub.status === "paused" ? "Paused" : "Canceled"}</dd>
          <dt>Per year</dt>
          <dd className="num">{money(Number(eq.yearly_cents), cur)}</dd>
          {sub.cycle !== "monthly" && (<><dt>Per month</dt><dd className="num">{money(Number(eq.monthly_cents), cur)}</dd></>)}
          <dt>Category</dt>
          <dd>{category?.name ?? "None"}</dd>
          <dt>Paid from</dt>
          <dd>{account?.name ?? "Not set"}</dd>
          <dt>Last logged</dt>
          <dd>{lastLogged ? shortDay(lastLogged) : "Never"}</dd>
          {sub.notes.trim() && (<><dt>Notes</dt><dd>{sub.notes}</dd></>)}
        </dl>

        {logging && canLog && (
          <div className="fin-inline-edit">
            <div className="form-row">
              <div className="field">
                <label className="label" htmlFor="fin-sub-log-date">Charged on</label>
                <input id="fin-sub-log-date" className="input" type="date" min="1900-01-01" max={today} value={logDate} onChange={(e) => setLogDate(e.target.value)} />
              </div>
              <div className="field">
                <label className="label" htmlFor="fin-sub-log-amount">Amount</label>
                <MoneyInput id="fin-sub-log-amount" currency={cur} value={logAmount} onChange={setLogAmount} label="Amount" />
              </div>
            </div>
            <div className="fin-actions">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setLogging(false); setError(null); }}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy || draft.stale} onClick={() => void logCharge()}>
                {busy && <Spinner />}Log {logCents !== null && logCents > 0 ? money(logCents, cur) : "charge"}
              </button>
            </div>
          </div>
        )}

        {draft.stale && <div className="banner neg">{STALE_DRAFT}</div>}
        {error && <div className="banner neg" role="alert">{error}</div>}

        <div className="list fin-sub-manage">
          {manage.map((m) => {
            const Icon = m.icon;
            return (
              <button key={m.key} type="button" className="item clickable" disabled={busy} onClick={m.run}>
                <span className="icon-tile sm"><Icon /></span>
                <div className="item-main">
                  <div className={`item-title ${m.danger ? "neg" : ""}`}>{m.label}</div>
                  <div className="item-sub">{m.sub}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
