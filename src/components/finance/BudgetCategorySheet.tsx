"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Modal, Spinner } from "@/components/ui";
import { Progress } from "@/components/kit";
import { useToast } from "@/components/providers";
import { centsToInput, money } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { currentBudgetMonth, lastDateOfMonth, transactionsForMonth, validateBudgetInput, type BudgetRow } from "@/lib/budget-planner";
import { FINANCE_MAX_CENTS, type BudgetMonth, type FinanceTransaction } from "@/lib/finance-types";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { CategoryTile, MoneyInput, TxAmount, errorText, monthLong, relativeDay, useDraftContext } from "./kit";
import { TransactionEditor } from "./TransactionEditor";

const MAX_ROWS = 30;

/** Drill-down for one budget row: quick limit edit plus this month's spending in the category. */
export function BudgetCategorySheet({ open, row, month, budget, onClose }: {
  open: boolean; row: BudgetRow | null; month: string; budget: BudgetMonth | undefined; onClose: () => void;
}) {
  const { bundle, currency, today, api } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ tx: FinanceTransaction | null } | null>(null);

  const categoryId = row?.category.id;
  useEffect(() => {
    if (!open || !row) { draft.release(); setEditing(null); return; }
    setLimit(row.limit_cents !== null ? centsToInput(row.limit_cents) : "");
    setError(null);
    setBusy(false);
    draft.capture();
    // Only reset when the dialog opens or switches category; live reloads must not rewrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, categoryId]);

  const txs = useMemo(
    () => (categoryId ? transactionsForMonth(bundle.transactions, month).filter((t) => t.kind === "expense" && t.category_id === categoryId) : []),
    [bundle.transactions, month, categoryId],
  );
  const total = useMemo(() => txs.reduce((a, t) => a + t.amount_cents, 0), [txs]);

  if (!row) return null;
  const monthName = monthLong(month).split(" ")[0];
  const hasLimit = row.limit_cents !== null;
  const remaining = row.remaining_cents;
  const cur = draft.captured?.currency ?? currency;
  const isCurrent = month === currentBudgetMonth(today);
  const addDate = isCurrent ? today : (() => { const last = lastDateOfMonth(month); return last < today ? last : today; })();

  async function save(remove: boolean) {
    if (!row) return;
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    let cents = 0;
    if (!remove) {
      if (!limit.trim()) return setError("Enter a limit, or use Remove limit.");
      const parsed = parseMoney(limit);
      if (parsed === null || parsed < 0 || parsed > FINANCE_MAX_CENTS) return setError("Enter an amount like 250 or 99.50.");
      cents = parsed;
    }
    const base = budget ?? null;
    const income = base?.income_cents ?? bundle.settings?.monthly_net_cents ?? 0;
    const others = (base?.limits ?? []).filter((l) => l.category_id !== row.category.id);
    const limits = remove ? others : [...others, { category_id: row.category.id, limit_cents: cents }];
    const input = { month, income_cents: income, limits };
    const errors = validateBudgetInput(input, bundle.categories);
    if (errors.length) return setError(errors[0]);
    setBusy(true);
    setError(null);
    try {
      await api.saveBudget(input, draft.captured);
      toast.ok(remove ? "Limit removed" : "Limit saved");
      if (remove) setLimit("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const figure = hasLimit && remaining !== null
    ? remaining < 0 ? <span className="neg">{money(-remaining, currency)} over</span> : <>{money(remaining, currency)} left</>
    : <>{money(row.used_cents, currency)} spent</>;

  return (
    <>
      <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={row.category.name}
        footer={<>
          <button type="button" className="btn btn-ghost" style={{ marginRight: "auto" }} onClick={() => setEditing({ tx: null })}><Plus /> Add expense</button>
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </>}>
        <div className="stack">
          <div className="fin-sheet-head">
            <div className="serif">{figure}</div>
            {row.percent !== null && <span className="hint num">{row.percent}%</span>}
          </div>
          {hasLimit && (row.limit_cents ?? 0) > 0 && (
            <Progress value={row.used_cents} max={row.limit_cents ?? 0} tone={row.status === "over" ? "neg" : "pos"} />
          )}
          {draft.stale && <div className="banner neg">{STALE_DRAFT}</div>}
          <form className="fin-inline-edit" onSubmit={(e) => { e.preventDefault(); void save(false); }}>
            <label className="label" htmlFor="fin-bud-limit">Limit for {monthName}</label>
            <MoneyInput id="fin-bud-limit" currency={cur} value={limit} onChange={setLimit} placeholder="No limit" />
            {error && <div className="banner neg" role="alert">{error}</div>}
            <div className="row-flex">
              {hasLimit && (
                <button type="button" className="btn btn-ghost" style={{ minHeight: 36, marginRight: "auto" }} disabled={busy || draft.stale} onClick={() => void save(true)}>Remove limit</button>
              )}
              <button type="submit" className="btn btn-primary" style={{ minHeight: 36 }} disabled={busy || draft.stale}>{busy && <Spinner />}Save limit</button>
            </div>
          </form>
          <div>
            <div className="fin-group-head">
              <span>{txs.length} {txs.length === 1 ? "transaction" : "transactions"}</span>
              <span className="num">{money(total, currency)}</span>
            </div>
            {txs.length ? (
              <div className="list">
                {txs.slice(0, MAX_ROWS).map((t) => (
                  <button type="button" className="item clickable" key={t.id} onClick={() => setEditing({ tx: t })}>
                    <CategoryTile category={row.category} size="sm" />
                    <div className="item-main">
                      <div className="item-title">{t.description}</div>
                      <div className="item-sub">{relativeDay(t.date, today)}</div>
                    </div>
                    <div className="item-end"><div className="v"><TxAmount tx={t} currency={currency} /></div></div>
                  </button>
                ))}
              </div>
            ) : <p className="hint">Nothing spent here this month.</p>}
            {txs.length > MAX_ROWS && (
              <p style={{ margin: "8px 0 0" }}>
                <Link href={`/finance/activity?category=${row.category.id}&month=${month.slice(0, 7)}`} className="btn btn-sm" style={{ minHeight: 36 }}>See all in Activity</Link>
              </p>
            )}
          </div>
        </div>
      </Modal>
      <TransactionEditor open={editing !== null} tx={editing?.tx ?? null}
        defaults={{ category_id: row.category.id, kind: "expense", date: addDate }} onClose={() => setEditing(null)} />
    </>
  );
}
