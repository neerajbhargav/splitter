"use client";
import { useEffect, useState } from "react";
import { Modal, Segmented, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { centsToInput } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { isIsoDate } from "@/lib/paycheck-planner";
import { FINANCE_MAX_CENTS, type PayCycle } from "@/lib/finance-types";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { MoneyInput, errorText, useDraftContext } from "./kit";

const CYCLES: { id: PayCycle; label: string }[] = [
  { id: "weekly", label: "Weekly" },
  { id: "biweekly", label: "Every 2 weeks" },
  { id: "semimonthly", label: "Twice a month" },
  { id: "monthly", label: "Monthly" },
];

/** Set up, change or remove the pay schedule that the Paycheck planner builds on. */
export function PayScheduleEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { bundle, currency, api, today, demo } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const s = bundle.settings;
  const [cycle, setCycle] = useState<PayCycle>("biweekly");
  const [anchor, setAnchor] = useState(today);
  const [day2, setDay2] = useState(31);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const hasSchedule = !!s?.pay_cycle;

  useEffect(() => {
    if (!open) { draft.release(); return; }
    setCycle(s?.pay_cycle ?? "biweekly");
    setAnchor(s?.pay_anchor ? String(s.pay_anchor).slice(0, 10) : today);
    setDay2(s?.pay_day2 ?? 31);
    setAmount(s?.paycheck_cents ? centsToInput(s.paycheck_cents) : "");
    setError(null);
    setConfirmRemove(false);
    draft.capture();
    // Reset only when the dialog opens; live reloads must not rewrite the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const anchorDay = isIsoDate(anchor) ? Number(anchor.slice(8, 10)) : null;
  const cur = draft.captured?.currency ?? currency;

  function fail(e: unknown) {
    if (demo) toast.err(e);
    else setError(errorText(e));
  }

  async function save() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    if (!isIsoDate(anchor)) return setError("Pick a recent or upcoming payday.");
    if (cycle === "semimonthly" && day2 === anchorDay) return setError("Your two paydays need to be on different days of the month.");
    const cents = amount.trim() ? parseMoney(amount) : 0;
    if (cents === null || cents < 0) return setError("Enter your usual take-home, like 2857.89.");
    if (cents > FINANCE_MAX_CENTS) return setError("That amount is too large to track.");
    setBusy(true);
    setError(null);
    try {
      await api.savePaySchedule({ pay_cycle: cycle, pay_anchor: anchor, pay_day2: cycle === "semimonthly" ? day2 : null, paycheck_cents: cents }, draft.captured);
      toast.ok(hasSchedule ? "Pay schedule updated" : "Pay schedule saved");
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    setBusy(true);
    try {
      await api.savePaySchedule({ pay_cycle: null }, draft.captured);
      toast.ok("Pay schedule removed. Your saved paycheck plans are still here.");
      onClose();
    } catch (e) {
      setConfirmRemove(false);
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const anchorLabel = cycle === "semimonthly" ? "First payday of the month" : "A recent or upcoming payday";
  const anchorHint = cycle === "weekly" || cycle === "biweekly"
    ? "Any real payday works. We count forward and back from it."
    : cycle === "monthly"
      ? "We use its day of the month. Short months move it to the last day."
      : "Pick any date that falls on this payday. We use its day of the month.";

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={hasSchedule ? "Pay schedule" : "Set up pay schedule"}
      footer={(
        <>
          {hasSchedule && !confirmRemove && (
            <button type="button" className="btn btn-ghost" style={{ marginRight: "auto" }} disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="fin-pay-schedule" className="btn btn-primary" disabled={busy || draft.stale}>{busy && <Spinner />}Save</button>
        </>
      )}>
      <form id="fin-pay-schedule" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="field">
          <span className="label" id="fin-pay-cycle-label">How often you get paid</span>
          <div role="group" aria-labelledby="fin-pay-cycle-label" className="fin-pay-seg">
            <Segmented value={cycle} options={CYCLES} onChange={setCycle} block />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="fin-pay-anchor">{anchorLabel}</label>
          <input id="fin-pay-anchor" type="date" className="input" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
          <span className="hint">{anchorHint}</span>
        </div>
        {cycle === "semimonthly" && (
          <div className="field">
            <label className="label" htmlFor="fin-pay-day2">Second payday of the month</label>
            <select id="fin-pay-day2" className="select" value={day2} onChange={(e) => setDay2(Number(e.target.value))}>
              {Array.from({ length: 30 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d} disabled={d === anchorDay}>{ordinal(d)}</option>
              ))}
              <option value={31} disabled={anchorDay === 31}>Last day of the month</option>
            </select>
          </div>
        )}
        <div className="field">
          <label className="label" htmlFor="fin-pay-amount">Usual take-home per paycheck</label>
          <MoneyInput id="fin-pay-amount" currency={cur} value={amount} onChange={setAmount} />
          <span className="hint">What lands in your account after taxes. You can change it on any single paycheck.</span>
        </div>
        {error && <div className="banner neg" role="alert">{error}</div>}
        {confirmRemove && (
          <div className="banner" role="alert">
            <span className="min0">Remove your pay schedule? Paychecks you already planned stay saved.</span>
            <button type="button" className="btn btn-sm" onClick={() => setConfirmRemove(false)} disabled={busy}>Keep</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} disabled={busy}>Remove</button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}
