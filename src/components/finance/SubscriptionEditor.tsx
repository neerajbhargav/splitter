"use client";
import { useEffect, useState } from "react";
import { Modal, Segmented, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { centsToInput } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { isValidCalendarDate, nextRenewalDate, validateSubscription } from "@/lib/subscription-planner";
import { ACCOUNT_TYPE_LABEL, CATEGORY_KIND_LABEL, FINANCE_MAX_CENTS, type Subscription, type SubscriptionCycle } from "@/lib/finance-types";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { MoneyInput, errorText, useDraftContext } from "./kit";

export type SubscriptionPrefill = Partial<Pick<Subscription, "name" | "amount_cents" | "cycle" | "anchor_date" | "category_id" | "account_id" | "notes">>;

const CYCLE_OPTIONS: { id: SubscriptionCycle; label: string }[] = [
  { id: "weekly", label: "Weekly" }, { id: "monthly", label: "Monthly" }, { id: "quarterly", label: "Quarterly" }, { id: "yearly", label: "Yearly" },
];

/** Add or edit one subscription. */
export function SubscriptionEditor({ open, subscription, prefill, onClose }: {
  open: boolean; subscription: Subscription | null; prefill?: SubscriptionPrefill | null; onClose: () => void;
}) {
  const { bundle, currency, today, api } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cycle, setCycle] = useState<SubscriptionCycle>("monthly");
  const [date, setDate] = useState(today);
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [initial, setInitial] = useState<{ date: string; cycle: SubscriptionCycle }>({ date: today, cycle: "monthly" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { draft.release(); return; }
    const subsCat = bundle.categories.find((c) => !c.archived && c.name.trim().toLowerCase() === "subscriptions");
    const startCycle: SubscriptionCycle = subscription?.cycle ?? prefill?.cycle ?? "monthly";
    const startDate = subscription
      ? nextRenewalDate(subscription.anchor_date, subscription.cycle, today) ?? subscription.anchor_date
      : prefill?.anchor_date ?? today;
    setName(subscription?.name ?? prefill?.name ?? "");
    setAmount(subscription ? centsToInput(subscription.amount_cents) : prefill?.amount_cents !== undefined ? centsToInput(prefill.amount_cents) : "");
    setCycle(startCycle);
    setDate(startDate);
    setInitial({ date: startDate, cycle: startCycle });
    setCategoryId(subscription ? subscription.category_id ?? "" : prefill?.category_id ?? subsCat?.id ?? "");
    setAccountId(subscription?.account_id ?? prefill?.account_id ?? "");
    setNotes(subscription?.notes ?? prefill?.notes ?? "");
    setError(null);
    draft.capture();
    // Only reset when the dialog opens or switches entity; live reloads must not rewrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subscription?.id]);

  const categories = bundle.categories.filter((c) => !c.archived || c.id === categoryId);
  const cents = parseMoney(amount);

  async function save() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    if (!name.trim()) return setError("Add a name.");
    if (cents === null || cents < 0 || cents > FINANCE_MAX_CENTS) return setError("Enter an amount like 12.99.");
    if (!isValidCalendarDate(date)) return setError("Pick the next billing date.");
    // Keep the saved day of month unless the user actually moved the date or the cycle (a 31st must stay a 31st).
    const anchor = subscription && date === initial.date && cycle === initial.cycle ? subscription.anchor_date : date;
    const status = subscription?.status ?? "active";
    const invalid = validateSubscription({ name, amount_cents: cents, cycle, anchor_date: anchor, status });
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      await api.saveSubscription({
        id: subscription?.id, name: name.trim(), amount_cents: cents, cycle, anchor_date: anchor, status,
        notes: notes.trim(), category_id: categoryId || null, account_id: accountId || null,
      }, draft.captured);
      toast.ok(subscription ? "Subscription saved" : "Subscription added");
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={subscription ? "Edit subscription" : "Add subscription"}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="fin-sub-form" className="btn btn-primary" disabled={busy || draft.stale}>{busy && <Spinner />}{subscription ? "Save" : "Add"}</button>
      </>}>
      <form id="fin-sub-form" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="field">
          <label className="label" htmlFor="fin-sub-name">Name</label>
          <input id="fin-sub-name" className="input" maxLength={100} autoFocus={!subscription} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Netflix, gym, cloud storage" />
        </div>
        <div className="field">
          <MoneyInput id="fin-sub-amount" large currency={draft.captured?.currency ?? currency} value={amount} onChange={setAmount} label="Amount" />
          {cents === 0 && <p className="hint">Free for now. We&apos;ll still show the renewal.</p>}
        </div>
        <div className="field">
          <span className="label" id="fin-sub-cycle-label">How often</span>
          <div role="group" aria-labelledby="fin-sub-cycle-label">
            <Segmented<SubscriptionCycle> block value={cycle} onChange={setCycle} options={CYCLE_OPTIONS} />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label className="label" htmlFor="fin-sub-date">Next billing date</label>
            <input id="fin-sub-date" className="input" type="date" min="1900-01-01" max="2200-12-31" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="fin-sub-cat">Category</label>
            <select id="fin-sub-cat" className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">None</option>
              {(["needs", "wants", "savings"] as const).map((k) => {
                const list = categories.filter((c) => c.kind === k);
                return list.length ? (
                  <optgroup key={k} label={CATEGORY_KIND_LABEL[k]}>
                    {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                ) : null;
              })}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="fin-sub-account">Paid from</label>
          <select id="fin-sub-account" className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Not set</option>
            {bundle.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` ··${a.last4}` : ""} · {ACCOUNT_TYPE_LABEL[a.type]}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="fin-sub-notes">Notes</label>
          <textarea id="fin-sub-notes" className="textarea" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Plan, login email, how to cancel" />
        </div>
        {draft.stale && <div className="banner neg">{STALE_DRAFT}</div>}
        {error && <div className="banner neg" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
