"use client";
import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal, Segmented, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { centsToInput } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { normalizeMerchant } from "@/lib/finance-import";
import { ACCOUNT_TYPE_LABEL, CATEGORY_KIND_LABEL, FINANCE_MAX_CENTS, type FinanceTransaction, type TxKind } from "@/lib/finance-types";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { MoneyInput, errorText, useDraftContext } from "./kit";

export type TxDefaults = Partial<Pick<FinanceTransaction, "date" | "kind" | "category_id" | "account_id" | "description">>;

const KIND_OPTIONS: { id: TxKind; label: string }[] = [
  { id: "expense", label: "Expense" }, { id: "income", label: "Income" }, { id: "transfer", label: "Transfer" },
];
const SOURCE_NOTE: Record<FinanceTransaction["source"], string | null> = {
  manual: null, csv: "Imported from a CSV file.", plaid: "Synced from your bank. Edits stay, except the bank can update amount and date.", subscription: "Logged from Subscriptions.",
};

/** Add or edit one ledger line. Used by Overview, Activity, Budget and Accounts. */
export function TransactionEditor({ open, tx, defaults, onClose }: { open: boolean; tx: FinanceTransaction | null; defaults?: TxDefaults; onClose: () => void }) {
  const { bundle, currency, today, api } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const [kind, setKind] = useState<TxKind>("expense");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(today);
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [applyAll, setApplyAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { draft.release(); return; }
    setKind(tx?.kind ?? defaults?.kind ?? "expense");
    setAmount(tx ? centsToInput(tx.amount_cents) : "");
    setDescription(tx?.description ?? defaults?.description ?? "");
    setDate(tx?.date ?? defaults?.date ?? today);
    setCategoryId(tx?.category_id ?? defaults?.category_id ?? "");
    setAccountId(tx?.account_id ?? defaults?.account_id ?? "");
    setApplyAll(false);
    setConfirmDelete(false);
    setError(null);
    draft.capture();
    // Only reset when the dialog opens or switches entity; live reloads must not rewrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tx?.id]);

  const categories = bundle.categories.filter((c) => !c.archived || c.id === categoryId);
  const merchantKey = useMemo(() => normalizeMerchant(description), [description]);
  const sameMerchant = useMemo(() => {
    if (!tx || kind !== "expense" || !merchantKey || categoryId === (tx.category_id ?? "")) return [];
    return bundle.transactions.filter((t) => t.id !== tx.id && t.kind === "expense" && (t.category_id ?? "") !== categoryId && normalizeMerchant(t.description) === merchantKey);
  }, [bundle.transactions, tx, kind, merchantKey, categoryId]);
  const subscription = tx?.subscription_id ? bundle.subscriptions.find((s) => s.id === tx.subscription_id) : null;

  async function save() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    const cents = parseMoney(amount);
    if (cents === null || cents <= 0 || cents > FINANCE_MAX_CENTS) return setError("Enter an amount greater than zero.");
    if (!description.trim()) return setError("Add a short description, like the merchant name.");
    if (!date || date > today) return setError("Pick a date that has already happened.");
    setBusy(true);
    setError(null);
    try {
      await api.saveTransaction({
        id: tx?.id, kind, amount_cents: cents, description: description.trim(), date,
        category_id: kind === "expense" ? categoryId || null : null, account_id: accountId || null, subscription_id: tx?.subscription_id ?? null,
      }, draft.captured);
      if (applyAll && sameMerchant.length) await api.recategorize(sameMerchant.map((t) => t.id), categoryId || null, draft.captured);
      toast.ok(tx ? (applyAll && sameMerchant.length ? `Updated ${sameMerchant.length + 1} transactions` : "Transaction updated") : "Transaction added");
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!tx || !draft.captured) return;
    setBusy(true);
    try {
      await api.deleteTransaction(tx.id, draft.captured);
      toast.ok("Transaction deleted");
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={tx ? "Edit transaction" : "Add transaction"}
      footer={confirmDelete ? (
        <><span className="hint" style={{ marginRight: "auto" }}>Delete this transaction?</span>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>Delete</button></>
      ) : (
        <>{tx && <button type="button" className="btn btn-ghost btn-icon" style={{ marginRight: "auto" }} aria-label="Delete transaction" onClick={() => setConfirmDelete(true)}><Trash2 /></button>}
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="fin-tx-form" className="btn btn-primary" disabled={busy || draft.stale}>{busy && <Spinner />}{tx ? "Save" : "Add"}</button></>
      )}>
      <form id="fin-tx-form" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Segmented<TxKind> block value={kind} onChange={setKind} options={KIND_OPTIONS} />
        <MoneyInput id="fin-tx-amount" large autoFocus={!tx} currency={draft.captured?.currency ?? currency} value={amount} onChange={setAmount} label="Amount" />
        <div className="field">
          <label className="label" htmlFor="fin-tx-desc">Description</label>
          <input id="fin-tx-desc" className="input" maxLength={140} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={kind === "income" ? "Paycheck, refund, side income" : kind === "transfer" ? "Card payment, move to savings" : "Groceries, coffee, rent"} />
        </div>
        <div className="form-row">
          <div className="field">
            <label className="label" htmlFor="fin-tx-date">Date</label>
            <input id="fin-tx-date" className="input" type="date" max={today} min="1900-01-01" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="fin-tx-account">Account</label>
            <select id="fin-tx-account" className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">No account</option>
              {bundle.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` ··${a.last4}` : ""} · {ACCOUNT_TYPE_LABEL[a.type]}</option>)}
            </select>
          </div>
        </div>
        {kind === "expense" && (
          <div className="field">
            <label className="label" htmlFor="fin-tx-cat">Category</label>
            <select id="fin-tx-cat" className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Uncategorized</option>
              {(["needs", "wants", "savings"] as const).map((k) => (
                <optgroup key={k} label={CATEGORY_KIND_LABEL[k]}>
                  {categories.filter((c) => c.kind === k).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              ))}
            </select>
            {sameMerchant.length > 0 && (
              <label className="row-flex hint" style={{ gap: 8, marginTop: 4, cursor: "pointer" }}>
                <input type="checkbox" className="fin-check" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
                Also apply to {sameMerchant.length} other transaction{sameMerchant.length === 1 ? "" : "s"} from this merchant
              </label>
            )}
          </div>
        )}
        {kind === "transfer" && <p className="hint">Transfers move your own money, like paying a card or saving. They never count as spending or income.</p>}
        {subscription && <p className="hint">Linked to your {subscription.name} subscription.</p>}
        {tx && SOURCE_NOTE[tx.source] && <p className="hint">{SOURCE_NOTE[tx.source]}{tx.pending ? " Still pending at the bank." : ""}</p>}
        {draft.stale && <div className="banner neg">{STALE_DRAFT}</div>}
        {error && <div className="banner neg" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
