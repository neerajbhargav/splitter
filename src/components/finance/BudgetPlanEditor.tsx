"use client";
import { useEffect, useMemo, useState } from "react";
import { Modal, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { centsToInput, money } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { addBudgetMonths, copyLimits, starterLimits, validateBudgetInput } from "@/lib/budget-planner";
import { monthActivity } from "@/lib/finance-insights";
import { CATEGORY_KIND_LABEL, FINANCE_MAX_CENTS, type BudgetLimit, type BudgetMonth, type CategoryKind } from "@/lib/finance-types";
import { STALE_DRAFT, useFinance } from "./FinanceProvider";
import { CategoryTile, MoneyInput, errorText, monthLong, useDraftContext } from "./kit";

const KINDS: CategoryKind[] = ["needs", "wants", "savings"];

/** Whole-month plan: take-home plus a limit per category. Nothing is saved until "Save plan". */
export function BudgetPlanEditor({ open, month, budget, initial, onClose }: {
  open: boolean; month: string; budget: BudgetMonth | undefined; initial?: { income_cents: number; limits: BudgetLimit[] } | null; onClose: () => void;
}) {
  const { bundle, currency, api } = useFinance();
  const toast = useToast();
  const draft = useDraftContext();
  const [income, setIncome] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState<Record<CategoryKind, string>>({ needs: "", wants: "", savings: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prevMonth = addBudgetMonths(month, -1);
  const prevBudget = bundle.budgets.find((b) => b.month === prevMonth);
  const prevUsed = useMemo(() => monthActivity(bundle.transactions, bundle.categories, prevMonth).byCategory, [bundle.transactions, bundle.categories, prevMonth]);

  useEffect(() => {
    if (!open) { draft.release(); return; }
    const source = initial ?? (budget
      ? { income_cents: budget.income_cents, limits: budget.limits }
      : { income_cents: bundle.settings?.monthly_net_cents ?? 0, limits: [] as BudgetLimit[] });
    setIncome(source.income_cents > 0 ? centsToInput(source.income_cents) : "");
    const next: Record<string, string> = {};
    for (const l of source.limits) next[l.category_id] = centsToInput(l.limit_cents);
    setValues(next);
    setNewName({ needs: "", wants: "", savings: "" });
    setError(null);
    setBusy(false);
    draft.capture();
    // Only reset when the dialog opens or the month changes; live reloads must not rewrite a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, month]);

  const incomeCents = parseMoney(income) ?? 0;
  const groups = useMemo(() => KINDS.map((kind) => ({
    kind,
    cats: bundle.categories
      .filter((c) => c.kind === kind && (!c.archived || (values[c.id] ?? "").trim() !== ""))
      .sort((a, b) => a.sort - b.sort || (a.name < b.name ? -1 : 1)),
  })), [bundle.categories, values]);
  const subtotal = (ids: string[]) => ids.reduce((a, id) => a + (parseMoney(values[id] ?? "") ?? 0), 0);
  const assigned = bundle.categories.reduce((a, c) => a + (parseMoney(values[c.id] ?? "") ?? 0), 0);
  const ready = incomeCents - assigned;
  const copyable = copyLimits(prevBudget, bundle.categories);
  const cur = draft.captured?.currency ?? currency;

  function fill(limits: BudgetLimit[]) {
    const next: Record<string, string> = {};
    for (const l of limits) next[l.category_id] = centsToInput(l.limit_cents);
    setValues(next);
  }

  async function addCategory(kind: CategoryKind) {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    const name = newName[kind].trim();
    if (!name) return setError("Name the category first.");
    setBusy(true);
    setError(null);
    try {
      await api.saveCategory({ name, kind }, draft.captured);
      setNewName((n) => ({ ...n, [kind]: "" }));
      toast.ok("Category added");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft.captured || draft.stale) return setError(STALE_DRAFT);
    let incomeValue = 0;
    if (income.trim()) {
      const parsed = parseMoney(income);
      if (parsed === null || parsed < 0 || parsed > FINANCE_MAX_CENTS) return setError("Enter your take-home, or leave it blank.");
      incomeValue = parsed;
    }
    const limits: BudgetLimit[] = [];
    for (const c of bundle.categories) {
      const v = values[c.id];
      if (v === undefined || v.trim() === "") continue;
      const parsed = parseMoney(v);
      if (parsed === null || parsed < 0 || parsed > FINANCE_MAX_CENTS) return setError(`Check the limit for ${c.name}.`);
      limits.push({ category_id: c.id, limit_cents: parsed });
    }
    if (incomeValue === 0 && limits.length === 0) return setError("Add your take-home or at least one limit.");
    const input = { month, income_cents: incomeValue, limits };
    const errors = validateBudgetInput(input, bundle.categories);
    if (errors.length) return setError(errors[0]);
    setBusy(true);
    setError(null);
    try {
      await api.saveBudget(input, draft.captured);
      toast.ok("Plan saved");
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const readyLabel = ready < 0 ? "Over by" : "Ready to assign";

  return (
    <Modal open={open} wide onClose={() => { if (!busy) onClose(); }} title={`Plan ${monthLong(month)}`}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="fin-plan-form" className="btn btn-primary" disabled={busy || draft.stale}>{busy && <Spinner />}Save plan</button>
      </>}>
      <form id="fin-plan-form" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="field">
          <label className="label" htmlFor="fin-plan-income">Take-home this month</label>
          <MoneyInput id="fin-plan-income" large currency={cur} value={income} onChange={setIncome} label="Take-home this month" />
        </div>
        <div className="fin-bud-ready" aria-live="polite">
          <span className="hint">{readyLabel}</span>
          {ready === 0 && incomeCents > 0
            ? <b>Every dollar has a job</b>
            : <b className={ready < 0 ? "neg" : ready > 0 ? "" : "pos"} style={ready > 0 ? { color: "var(--gold-text)" } : undefined}>{money(Math.abs(ready), currency)}</b>}
        </div>
        <div className="fin-actions">
          <button type="button" className="btn btn-sm" style={{ minHeight: 36 }} disabled={incomeCents <= 0}
            onClick={() => fill(starterLimits({ incomeCents, categories: bundle.categories }))}>50/30/20</button>
          <button type="button" className="btn btn-sm" style={{ minHeight: 36 }} disabled={copyable.length === 0} onClick={() => fill(copyable)}>Copy last month</button>
          <button type="button" className="btn btn-sm btn-ghost" style={{ minHeight: 36 }} onClick={() => setValues({})}>Clear</button>
        </div>
        {error && <div className="banner neg" role="alert">{error}</div>}
        {draft.stale && <div className="banner neg">{STALE_DRAFT}</div>}
        {bundle.categories.length === 0 && <p className="hint">Add a category to start planning.</p>}
        {groups.map(({ kind, cats }) => (
          <div key={kind}>
            <div className="fin-group-head">
              <span>{CATEGORY_KIND_LABEL[kind]}</span>
              <span className="num">{money(subtotal(cats.map((c) => c.id)), currency)}</span>
            </div>
            {cats.map((c) => {
              const used = prevUsed[c.id] ?? 0;
              return (
                <div className="fin-bud-prow" key={c.id}>
                  <CategoryTile category={c} size="sm" />
                  <div className="min0">
                    <div className="item-title">{c.name}{c.archived && <span className="faint"> (archived)</span>}</div>
                    {used > 0 && <div className="item-sub">Last month {money(used, currency)}</div>}
                  </div>
                  <MoneyInput id={`fin-plan-${c.id}`} currency={cur} placeholder="No limit" label={`${c.name} limit`}
                    value={values[c.id] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [c.id]: v }))} />
                </div>
              );
            })}
            <div className="fin-bud-add">
              <input className="input input-sm" style={{ height: 36 }} maxLength={40} placeholder="New category" aria-label={`New ${kind} category`}
                value={newName[kind]} onChange={(e) => setNewName((n) => ({ ...n, [kind]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addCategory(kind); } }} />
              <button type="button" className="btn btn-sm" style={{ minHeight: 36 }} disabled={busy || draft.stale} onClick={() => void addCategory(kind)}>Add</button>
            </div>
          </div>
        ))}
      </form>
    </Modal>
  );
}
