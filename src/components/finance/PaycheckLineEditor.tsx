"use client";
import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal, Spinner } from "@/components/ui";
import { centsToInput } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { ALLOCATION_KIND_LABEL, ALLOCATION_ORDER } from "@/lib/paycheck-planner";
import { FINANCE_MAX_CENTS, isLiability, type AllocationKind, type PaycheckAllocation } from "@/lib/finance-types";
import { useFinance } from "./FinanceProvider";
import { MoneyInput } from "./kit";

export type LineDraft = Omit<PaycheckAllocation, "id"> & { id?: string };

/** Add or edit one line of a paycheck plan. The page saves the whole paycheck. */
export function PaycheckLineEditor({ open, line, onClose, onSave, onDelete }: {
  open: boolean;
  line: LineDraft | null;
  onClose: () => void;
  onSave: (line: LineDraft) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
}) {
  const { bundle, currency } = useFinance();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<AllocationKind>("other");
  const [ref, setRef] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editing = !!line?.id;

  useEffect(() => {
    if (!open) return;
    setLabel(line?.label ?? "");
    setKind(line?.kind ?? "other");
    setRef(line?.ref_id ?? "");
    setAmount(line && line.amount_cents ? centsToInput(line.amount_cents) : "");
    setError(null);
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, line?.id]);

  const targets = useMemo(() => {
    if (kind === "bill") return bundle.subscriptions.filter((s) => s.status !== "canceled").map((s) => ({ id: s.id, name: s.name }));
    if (kind === "debt") return bundle.accounts.filter((a) => isLiability(a.type)).map((a) => ({ id: a.id, name: a.name }));
    if (kind === "spending") return bundle.categories.filter((c) => !c.archived && c.kind !== "savings").map((c) => ({ id: c.id, name: c.name }));
    if (kind === "savings") return bundle.categories.filter((c) => !c.archived && c.kind === "savings").map((c) => ({ id: c.id, name: c.name }));
    return [];
  }, [kind, bundle.subscriptions, bundle.accounts, bundle.categories]);

  const targetLabel = kind === "bill" ? "Which bill" : kind === "debt" ? "Which debt" : "Budget category";

  function pickTarget(id: string) {
    const prev = targets.find((t) => t.id === ref);
    setRef(id);
    const next = targets.find((t) => t.id === id);
    // Follow the linked name unless the label was customized.
    if (next && (!label.trim() || label === prev?.name)) setLabel(next.name);
  }

  async function save() {
    const l = label.trim();
    if (!l) return setError("Give this line a name, like Gas or Rent.");
    if (l.length > 80) return setError("Keep the name under 80 characters.");
    const cents = amount.trim() ? parseMoney(amount) : 0;
    if (cents === null || cents < 0) return setError("Enter an amount, like 120.00.");
    if (cents > FINANCE_MAX_CENTS) return setError("That amount is too large to track.");
    const refId = kind !== "other" && ref && targets.some((t) => t.id === ref) ? ref : null;
    setBusy(true);
    setError(null);
    const ok = await onSave({ id: line?.id, label: l, kind, ref_id: refId, amount_cents: cents, done: line?.done ?? false });
    setBusy(false);
    if (ok) onClose();
  }

  async function remove() {
    if (!onDelete) return;
    setBusy(true);
    const ok = await onDelete();
    setBusy(false);
    if (ok) onClose();
    else setConfirmDelete(false);
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={editing ? "Edit line" : "Add line"}
      footer={(
        <>
          {editing && onDelete && !confirmDelete && (
            <button type="button" className="btn btn-ghost btn-icon" style={{ marginRight: "auto" }} aria-label="Delete line" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 /></button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="fin-pay-line" className="btn btn-primary" disabled={busy}>{busy && <Spinner />}{editing ? "Save" : "Add"}</button>
        </>
      )}>
      <form id="fin-pay-line" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="field">
          <label className="label" htmlFor="fin-line-kind">Type</label>
          <select id="fin-line-kind" className="select" value={kind} onChange={(e) => { setKind(e.target.value as AllocationKind); setRef(""); }}>
            {ALLOCATION_ORDER.map((k) => <option key={k} value={k}>{ALLOCATION_KIND_LABEL[k]}</option>)}
          </select>
        </div>
        {kind !== "other" && (
          <div className="field">
            <label className="label" htmlFor="fin-line-ref">{targetLabel} <span className="faint">(optional)</span></label>
            <select id="fin-line-ref" className="select" value={ref} onChange={(e) => pickTarget(e.target.value)}>
              <option value="">Not linked</option>
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label className="label" htmlFor="fin-line-label">Name</label>
          <input id="fin-line-label" className="input" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder={kind === "savings" ? "Emergency fund" : kind === "spending" ? "Gas, groceries" : "Rent, buffer"} autoFocus={!editing} />
        </div>
        <div className="field">
          <label className="label" htmlFor="fin-line-amount">Amount</label>
          <MoneyInput id="fin-line-amount" currency={currency} value={amount} onChange={setAmount} />
        </div>
        {error && <div className="banner neg" role="alert">{error}</div>}
        {confirmDelete && (
          <div className="banner" role="alert">
            <span className="min0">Remove this line from the paycheck?</span>
            <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(false)} disabled={busy}>Keep</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} disabled={busy}>Remove</button>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Amount and note for one paycheck. */
export function PaycheckDetailsEditor({ open, amountCents, note, title, onClose, onSave }: {
  open: boolean;
  amountCents: number;
  note: string;
  title: string;
  onClose: () => void;
  onSave: (amountCents: number, note: string) => Promise<boolean>;
}) {
  const { currency } = useFinance();
  const [amount, setAmount] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAmount(amountCents ? centsToInput(amountCents) : "");
    setText(note);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    const cents = parseMoney(amount);
    if (cents === null || cents <= 0) return setError("Enter the take-home for this paycheck, like 2857.89.");
    if (cents > FINANCE_MAX_CENTS) return setError("That amount is too large to track.");
    if (text.trim().length > 300) return setError("Keep the note under 300 characters.");
    setBusy(true);
    setError(null);
    const ok = await onSave(cents, text.trim());
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={title}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="fin-pay-details" className="btn btn-primary" disabled={busy}>{busy && <Spinner />}Save</button>
        </>
      )}>
      <form id="fin-pay-details" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="field">
          <label className="label" htmlFor="fin-pay-this-amount">Take-home on this paycheck</label>
          <MoneyInput id="fin-pay-this-amount" currency={currency} value={amount} onChange={setAmount} autoFocus large />
          <span className="hint">Overtime, a bonus or a smaller check? Change it just for this one.</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="fin-pay-note">Note <span className="faint">(optional)</span></label>
          <textarea id="fin-pay-note" className="input" rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder="Includes travel reimbursement" style={{ height: "auto", paddingTop: 10 }} />
        </div>
        {error && <div className="banner neg" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
