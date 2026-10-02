'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { CHART_COLORS, Donut } from '@/components/charts';
import { Progress } from '@/components/kit';
import { Empty, Modal, Segmented, Spinner } from '@/components/ui';
import {
  MAX_BUDGET_CATEGORIES,
  MONEY_MAX,
  addBudgetMonths,
  copyBudgetMonth,
  isSafeMoney,
  lastDateOfBudgetMonth,
  monthFromInput,
  starter503020Categories,
  summarizeBudgetMonth,
  transactionsForMonth,
  validateBudgetInput,
  validateTransactionForMonth,
} from '@/lib/budget-planner';
import { financeApi } from '@/lib/finance-data';
import type { BudgetCategory, BudgetKind, BudgetMonth, BudgetTransaction, FinanceContext, FinanceToolProps } from '@/lib/finance-types';
import { centsToInput, money, monthLabel, todayISO } from '@/lib/format';
import { parseMoney } from '@/lib/split';

type View = 'overview' | 'plan' | 'transactions';
type CategoryDraft = { id: string; name: string; kind: BudgetKind; limit: string };

const kindLabel: Record<BudgetKind, string> = { needs: 'Needs', wants: 'Wants', savings: 'Savings' };
const adviceTone: Record<'info' | 'warning' | 'danger' | 'success', string> = {
  info: '', warning: 'faint', danger: 'neg', success: 'pos',
};

function newCategoryId(): string {
  return crypto.randomUUID();
}

function categoryDraft(category: BudgetCategory): CategoryDraft {
  return { id: category.id, name: category.name, kind: category.kind, limit: centsToInput(category.limit_cents) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function sameContext(left: FinanceContext | null, right: FinanceContext): left is FinanceContext {
  return !!left && left.userId === right.userId && left.currency === right.currency;
}

const STALE_EDITOR_MESSAGE = 'Your account or currency changed. Close and reopen this editor before saving.';

function monthInput(month: string): string {
  return month.slice(0, 7);
}

function currentMonth(): string {
  return `${todayISO().slice(0, 7)}-01`;
}

function categoryName(transaction: BudgetTransaction, budget: BudgetMonth | undefined): string {
  if (!transaction.category_id) return 'Uncategorized';
  return budget?.categories.find((category) => category.id === transaction.category_id)?.name ?? 'Uncategorized';
}

function CategoryBars({ summary, currency }: { summary: ReturnType<typeof summarizeBudgetMonth>; currency: string }) {
  if (!summary.category_summaries.length) return <Empty title="No categories yet">Add categories in the Plan tab to compare actual activity with limits.</Empty>;
  return (
    <div className="stack-sm">
      {summary.category_summaries.map((category) => {
        const over = category.status === 'over';
        const savings = category.kind === 'savings';
        const verb = savings ? 'contributed' : 'used';
        const remainingLabel = over
          ? savings ? `${money(Math.abs(category.remaining_cents), currency)} above target` : `${money(Math.abs(category.remaining_cents), currency)} over`
          : `${money(category.remaining_cents, currency)} left`;
        return (
          <div className="finance-list-row" key={category.id}>
            <div className="between">
              <div>
                <strong>{category.name}</strong>
                <div className="tiny faint">{kindLabel[category.kind]} · {verb} {money(category.used_cents, currency)} of {money(category.limit_cents, currency)}</div>
              </div>
              <span className={`num ${over && !savings ? 'neg' : savings ? 'pos' : ''}`}>{remainingLabel}</span>
            </div>
            <Progress value={category.used_cents} max={Math.max(1, category.limit_cents)} size="sm" tone={over && !savings ? 'neg' : 'pos'} />
          </div>
        );
      })}
    </div>
  );
}

function TransactionModal({
  open,
  transaction,
  month,
  categories,
  context,
  onClose,
  onSaved,
}: {
  open: boolean;
  transaction: BudgetTransaction | null;
  month: string;
  categories: BudgetCategory[];
  context: FinanceContext;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const today = todayISO();
  const latestDate = lastDateOfBudgetMonth(month) < today ? lastDateOfBudgetMonth(month) : today;
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(month);
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capturedContext, setCapturedContext] = useState<FinanceContext | null>(null);
  const contextStale = !sameContext(capturedContext, context);

  useEffect(() => {
    if (!open) {
      setCapturedContext(null);
      return;
    }
    if (capturedContext && !sameContext(capturedContext, context)) {
      setError(STALE_EDITOR_MESSAGE);
      return;
    }
    setDescription(transaction?.description ?? '');
    setAmount(transaction ? centsToInput(transaction.amount_cents) : '');
    setDate(transaction?.expense_date ?? (latestDate >= month ? latestDate : month));
    setCategoryId(transaction?.category_id ?? '');
    setCapturedContext({ userId: context.userId, currency: context.currency });
    setError(null);
  // Capture and reset only when the modal opens or its month/entity changes.
  // Bundle reloads and live currency/account prop updates must not mutate an open draft.
  }, [open, month, transaction?.id]);

  async function submit() {
    if (!capturedContext || contextStale) {
      setError(STALE_EDITOR_MESSAGE);
      return;
    }
    const cleanDescription = description.trim();
    if (!cleanDescription || cleanDescription.length > 100) {
      setError('Enter a description from 1 to 100 characters.');
      return;
    }
    const amountCents = parseMoney(amount);
    const errors = validateTransactionForMonth({
      amount_cents: amountCents ?? -1,
      expense_date: date,
      category_id: categoryId || null,
    }, month, today, new Set(categories.map((category) => category.id)));
    if (errors.length) {
      setError(errors[0]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await financeApi.saveTransaction({
        id: transaction?.id,
        description: cleanDescription,
        amount_cents: amountCents!,
        expense_date: date,
        category_id: categoryId || null,
        subscription_id: transaction?.subscription_id ?? null,
      }, capturedContext);
      await onSaved();
      onClose();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={transaction ? 'Edit transaction' : 'Log transaction'}
      footer={<div className="finance-actions"><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="budget-transaction-form" className="btn btn-primary" disabled={busy || contextStale}>{busy ? <Spinner /> : <Save />} Save</button></div>}
    >
      <form id="budget-transaction-form" className="stack" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="field">
          <label htmlFor="budget-tx-description">Description</label>
          <input id="budget-tx-description" className="input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Groceries, rent, savings transfer" maxLength={100} required autoFocus />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="budget-tx-amount">Amount</label>
            <input id="budget-tx-amount" className="input" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required />
          </div>
          <div className="field">
            <label htmlFor="budget-tx-date">Date</label>
            <input id="budget-tx-date" className="input" type="date" min={month} max={latestDate} value={date} onChange={(event) => setDate(event.target.value)} required />
          </div>
        </div>
        <div className="field">
          <label htmlFor="budget-tx-category">Category</label>
          <select id="budget-tx-category" className="input" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">Uncategorized</option>
            {categories.map((category) => <option value={category.id} key={category.id}>{category.name} ({kindLabel[category.kind]})</option>)}
          </select>
        </div>
        {transaction?.subscription_id && <p className="hint">This edit keeps its existing subscription link. The subscription plan is not charged twice.</p>}
        {contextStale && <p className="neg" role="alert">{STALE_EDITOR_MESSAGE}</p>}
        {error && !contextStale && <p className="neg" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

export function BudgetAssistant({ bundle, currency, userId, onRefresh }: FinanceToolProps) {
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [view, setView] = useState<View>('overview');
  const [income, setIncome] = useState('0.00');
  const [categories, setCategories] = useState<CategoryDraft[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingBudget, setSavingBudget] = useState(false);
  const [transactionOpen, setTransactionOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<BudgetTransaction | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draftContext, setDraftContext] = useState<FinanceContext | null>(null);
  const liveContextRef = useRef<FinanceContext>({ userId, currency });
  liveContextRef.current = { userId, currency };

  const budget = bundle.budgets.find((item) => item.month === selectedMonth);
  const previousBudget = bundle.budgets.find((item) => item.month === addBudgetMonths(selectedMonth, -1));
  const monthTransactions = useMemo(() => transactionsForMonth(bundle.transactions, selectedMonth), [bundle.transactions, selectedMonth]);
  const summary = useMemo(() => summarizeBudgetMonth({
    month: selectedMonth,
    budget,
    transactions: bundle.transactions,
    subscriptions: bundle.subscriptions,
    debts: bundle.debts,
  }), [selectedMonth, budget, bundle.transactions, bundle.subscriptions, bundle.debts]);
  const referencedCategoryIds = useMemo(() => new Set(bundle.transactions.flatMap((transaction) => transaction.category_id ? [transaction.category_id] : [])), [bundle.transactions]);
  const transactionAllowed = selectedMonth <= currentMonth();
  const budgetContextStale = !sameContext(draftContext, liveContextRef.current);

  useEffect(() => {
    if (view !== 'plan') {
      setDraftContext(null);
      return;
    }
    const currentContext = liveContextRef.current;
    if (draftContext && !sameContext(draftContext, currentContext)) {
      setError(STALE_EDITOR_MESSAGE);
      return;
    }
    setIncome(centsToInput(budget?.income_cents ?? 0));
    setCategories((budget?.categories ?? []).map(categoryDraft));
    setDraftContext({ ...currentContext });
    setError(null);
    setMessage(null);
  // A plan draft opens on entering Plan, changing month, or changing budget entity.
  // Bundle reloads and live currency/account changes must not rewrite an open draft.
  }, [view, selectedMonth, budget?.id]);

  const donutData = useMemo(() => {
    const data = summary.category_summaries.filter((category) => category.used_cents > 0).map((category, index) => ({
      key: category.id,
      name: category.kind === 'savings' ? `${category.name} contributions` : category.name,
      value: category.used_cents,
      color: CHART_COLORS[index % CHART_COLORS.length],
    }));
    if (summary.uncategorized_cents > 0) data.push({ key: 'uncategorized', name: 'Uncategorized', value: summary.uncategorized_cents, color: 'var(--ink-3)' });
    return data;
  }, [summary]);

  function chooseMonth(value: string) {
    const next = monthFromInput(value);
    if (next) setSelectedMonth(next);
  }

  function addCategory() {
    if (categories.length >= MAX_BUDGET_CATEGORIES) {
      setError(`A month can have at most ${MAX_BUDGET_CATEGORIES} categories.`);
      return;
    }
    setCategories((rows) => [...rows, { id: newCategoryId(), name: '', kind: 'needs', limit: '0.00' }]);
    setError(null);
  }

  function removeCategory(id: string) {
    if (referencedCategoryIds.has(id)) {
      setError('This category has transactions. Rename it instead of deleting it.');
      return;
    }
    setCategories((rows) => rows.filter((row) => row.id !== id));
  }

  function updateCategory(id: string, update: Partial<CategoryDraft>) {
    setCategories((rows) => rows.map((row) => row.id === id ? { ...row, ...update } : row));
  }

  function applyStarter() {
    const currentContext = liveContextRef.current;
    if (!sameContext(draftContext, currentContext)) {
      setError(STALE_EDITOR_MESSAGE);
      return;
    }
    if (categories.length) return;
    const incomeCents = parseMoney(income);
    if (incomeCents === null || !isSafeMoney(incomeCents)) {
      setError(`Enter take-home income from 0 to ${money(MONEY_MAX, currency)} first.`);
      return;
    }
    setCategories(starter503020Categories(incomeCents).map(categoryDraft));
    setError(null);
    setMessage('50/30/20 starter added. Review it before saving.');
  }

  function copyPrevious() {
    const currentContext = liveContextRef.current;
    if (!sameContext(draftContext, currentContext)) {
      setError(STALE_EDITOR_MESSAGE);
      return;
    }
    if (!previousBudget || categories.length || budget) return;
    const copied = copyBudgetMonth(previousBudget, selectedMonth);
    setIncome(centsToInput(copied.income_cents));
    setCategories(copied.categories.map(categoryDraft));
    setError(null);
    setMessage('Previous month copied with new category IDs. Review it before saving.');
  }

  async function saveBudget() {
    const capturedContext = draftContext;
    if (!sameContext(capturedContext, liveContextRef.current)) {
      setError(STALE_EDITOR_MESSAGE);
      return;
    }
    const incomeCents = parseMoney(income);
    const parsedCategories: BudgetCategory[] = [];
    for (const row of categories) {
      const limitCents = parseMoney(row.limit);
      if (limitCents === null) {
        setError(`Enter a valid limit for ${row.name || 'each category'}.`);
        return;
      }
      parsedCategories.push({ id: row.id, name: row.name.trim(), kind: row.kind, limit_cents: limitCents });
    }
    const input = { month: selectedMonth, income_cents: incomeCents ?? -1, categories: parsedCategories };
    const protectedRemoval = budget?.categories.find((category) => referencedCategoryIds.has(category.id) && !parsedCategories.some((next) => next.id === category.id));
    const errors = validateBudgetInput(input);
    if (protectedRemoval) errors.unshift(`${protectedRemoval.name} has transactions and cannot be removed. Rename it instead.`);
    if (errors.length) {
      setError(errors[0]);
      return;
    }
    setSavingBudget(true);
    setError(null);
    setMessage(null);
    try {
      await financeApi.saveBudget(input, capturedContext);
      await onRefresh();
      setMessage('Budget saved.');
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSavingBudget(false);
    }
  }

  function openNewTransaction() {
    setEditingTransaction(null);
    setTransactionOpen(true);
  }

  function openEditTransaction(transaction: BudgetTransaction) {
    setEditingTransaction(transaction);
    setTransactionOpen(true);
  }

  async function deleteTransaction(transaction: BudgetTransaction) {
    const capturedContext = { ...liveContextRef.current };
    if (!window.confirm(`Delete ${transaction.description || 'this transaction'}? This cannot be undone.`)) return;
    if (!sameContext(capturedContext, liveContextRef.current)) {
      setError('Your account or currency changed. Close any open editor and start the delete action again.');
      return;
    }
    setDeletingId(transaction.id);
    setError(null);
    try {
      await financeApi.deleteTransaction(transaction.id, capturedContext);
      await onRefresh();
      setMessage('Transaction deleted.');
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="finance-tool stack">
      <div className="between">
        <div>
          <h2 className="serif">Private budget assistant</h2>
          <p className="hint">Rule-based and on-device. It uses only the private records shown here, with no AI or external calls.</p>
        </div>
        <div className="finance-actions">
          <button type="button" className="btn btn-icon" onClick={() => setSelectedMonth((month) => addBudgetMonths(month, -1))} disabled={selectedMonth <= '1900-01-01'} aria-label="Previous month"><ChevronLeft /></button>
          <input className="input" type="month" min="1900-01" max="2200-12" aria-label="Budget month" value={monthInput(selectedMonth)} onChange={(event) => chooseMonth(event.target.value)} />
          <button type="button" className="btn btn-icon" onClick={() => setSelectedMonth((month) => addBudgetMonths(month, 1))} disabled={selectedMonth >= '2200-12-01'} aria-label="Next month"><ChevronRight /></button>
        </div>
      </div>

      <div className="between">
        <strong>{monthLabel(selectedMonth)}</strong>
        <Segmented<View> value={view} onChange={setView} options={[
          { id: 'overview', label: 'Overview' },
          { id: 'plan', label: 'Plan' },
          { id: 'transactions', label: 'Transactions' },
        ]} />
      </div>

      {message && <div className="card"><div className="card-body pos" role="status">{message}</div></div>}
      {error && <div className="card"><div className="card-body neg" role="alert">{error}</div></div>}

      {view === 'overview' && (
        <div className="stack">
          <div className="finance-stats">
            <div className="finance-stat"><span className="hint">Take-home income</span><strong className="num">{money(summary.income_cents, currency)}</strong></div>
            <div className="finance-stat"><span className="hint">Used</span><strong className="num">{money(summary.used_cents, currency)}</strong><span className="tiny faint">Spending plus savings contributions</span></div>
            <div className="finance-stat"><span className="hint">Spending</span><strong className="num">{money(summary.spending_cents, currency)}</strong></div>
            <div className="finance-stat"><span className="hint">Savings contributed</span><strong className="num pos">{money(summary.savings_contributions_cents, currency)}</strong></div>
            <div className="finance-stat"><span className="hint">Income remaining</span><strong className={`num ${summary.remaining_income_cents < 0 ? 'neg' : ''}`}>{money(summary.remaining_income_cents, currency)}</strong></div>
            <div className="finance-stat"><span className="hint">Unassigned plan</span><strong className={`num ${summary.unassigned_cents < 0 ? 'neg' : ''}`}>{money(summary.unassigned_cents, currency)}</strong><span className="tiny faint">Income minus category limits</span></div>
          </div>

          {!budget ? (
            <section className="card"><div className="card-body"><Empty title="No budget plan for this month" action={<button type="button" className="btn btn-primary" onClick={() => setView('plan')}>Build the plan</button>}>Nothing is created automatically. Add a starter or build categories manually.</Empty></div></section>
          ) : (
            <div className="finance-grid">
              <section className="card">
                <div className="card-head"><div><div className="card-title">Monthly activity</div><div className="card-desc">Used means spending plus savings contributions.</div></div></div>
                <div className="card-body"><Donut data={donutData} currency={currency} center={money(summary.used_cents, currency)} centerLabel="used this month" /></div>
              </section>
              <section className="card">
                <div className="card-head"><div><div className="card-title">Category progress</div><div className="card-desc">Savings rows measure contributions toward the target.</div></div></div>
                <div className="card-body"><CategoryBars summary={summary} currency={currency} /></div>
              </section>
            </div>
          )}

          <section className="card">
            <div className="card-head"><div><div className="card-title">Local assistant</div><div className="card-desc">Actionable checks based on this month&apos;s plan and manual logs.</div></div></div>
            <div className="card-body">
              {summary.advice.length ? <div className="stack-sm">{summary.advice.map((item) => <div className="finance-list-row" key={item.id}><strong className={adviceTone[item.tone]}>{item.title}</strong><p className="hint">{item.detail}</p></div>)}</div> : <p className="hint">Add a plan or transaction to get local guidance.</p>}
            </div>
          </section>

          {(summary.subscription_average_cents > 0 || summary.debt_minimums_cents > 0) && (
            <section className="card">
              <div className="card-head"><div><div className="card-title">Planning reminders</div><div className="card-desc">These figures are not silently subtracted, which avoids double counting logged charges.</div></div></div>
              <div className="card-body finance-stats">
                {summary.subscription_average_cents > 0 && <div className="finance-stat"><span className="hint">Active subscription average</span><strong className="num">{money(summary.subscription_average_cents, currency)}</strong></div>}
                {summary.debt_minimums_cents > 0 && <div className="finance-stat"><span className="hint">Debt minimums</span><strong className="num">{money(summary.debt_minimums_cents, currency)}</strong></div>}
              </div>
            </section>
          )}

          {summary.issues.length > 0 && <section className="card"><div className="card-head"><div className="card-title">Records to review</div></div><div className="card-body stack-sm">{summary.issues.map((issue, index) => <p className="hint" key={`${issue}-${index}`}>{issue}</p>)}</div></section>}
        </div>
      )}

      {view === 'plan' && (
        <section className="card">
          <div className="card-head">
            <div><div className="card-title">Monthly plan</div><div className="card-desc">Allocate planned take-home income across up to {MAX_BUDGET_CATEGORIES} categories.</div></div>
            <button type="button" className="btn btn-primary" onClick={() => void saveBudget()} disabled={savingBudget || budgetContextStale}>{savingBudget ? <Spinner /> : <Save />} Save budget</button>
          </div>
          <div className="card-body stack">
            {budgetContextStale && <p className="neg" role="alert">{STALE_EDITOR_MESSAGE}</p>}
            <div className="field">
              <label htmlFor="budget-income">Planned take-home income</label>
              <input id="budget-income" className="input" inputMode="decimal" value={income} onChange={(event) => setIncome(event.target.value)} placeholder="0.00" />
            </div>

            {!categories.length ? (
              <Empty title="Start with an empty plan" action={<div className="finance-actions"><button type="button" className="btn btn-primary" onClick={applyStarter} disabled={budgetContextStale}>Add 50/30/20 starter</button>{previousBudget && !budget && <button type="button" className="btn" onClick={copyPrevious} disabled={budgetContextStale}><Copy /> Copy previous month</button>}<button type="button" className="btn" onClick={addCategory}><Plus /> Add category</button></div>}>Starter categories are optional and appear only when you click. No private records are filled automatically.</Empty>
            ) : (
              <div className="finance-scroll">
                <table className="finance-table">
                  <thead><tr><th>Category</th><th>Kind</th><th>Monthly limit</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {categories.map((category) => {
                      const protectedRow = referencedCategoryIds.has(category.id);
                      return (
                        <tr key={category.id}>
                          <td><input className="input" aria-label="Category name" value={category.name} onChange={(event) => updateCategory(category.id, { name: event.target.value })} placeholder="Category name" maxLength={100} /></td>
                          <td><select className="input" aria-label={`${category.name || 'Category'} kind`} value={category.kind} onChange={(event) => updateCategory(category.id, { kind: event.target.value as BudgetKind })}><option value="needs">Needs</option><option value="wants">Wants</option><option value="savings">Savings</option></select></td>
                          <td><input className="input" aria-label={`${category.name || 'Category'} limit`} inputMode="decimal" value={category.limit} onChange={(event) => updateCategory(category.id, { limit: event.target.value })} placeholder="0.00" /></td>
                          <td><button type="button" className="btn btn-ghost btn-icon" onClick={() => removeCategory(category.id)} disabled={protectedRow} title={protectedRow ? 'This category has transactions. Rename it instead.' : 'Remove category'} aria-label={`Remove ${category.name || 'category'}`}><Trash2 /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="between">
              <p className="hint">Category IDs stay stable when you rename a row. Categories with transactions cannot be erased.</p>
              {categories.length > 0 && <button type="button" className="btn" onClick={addCategory} disabled={categories.length >= MAX_BUDGET_CATEGORIES}><Plus /> Add category</button>}
            </div>
            <p className="hint">Shared group ledgers are not imported. This tool uses manual private budget logs only.</p>
          </div>
        </section>
      )}

      {view === 'transactions' && (
        <section className="card">
          <div className="card-head">
            <div><div className="card-title">Manual transactions</div><div className="card-desc">Log spending and savings contributions for {monthLabel(selectedMonth)}.</div></div>
            <button type="button" className="btn btn-primary" onClick={openNewTransaction} disabled={!transactionAllowed}><Plus /> Log transaction</button>
          </div>
          <div className="card-body stack">
            {!transactionAllowed && <p className="hint">Future-dated logs are disabled. You can still plan this month&apos;s income and categories.</p>}
            {!monthTransactions.length ? <Empty title="No transactions logged">Manual logging only. There are no bank connections or push notifications.</Empty> : (
              <div className="finance-scroll">
                <table className="finance-table">
                  <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {monthTransactions.map((transaction) => {
                      const category = budget?.categories.find((item) => item.id === transaction.category_id);
                      return (
                        <tr key={transaction.id}>
                          <td>{transaction.expense_date}</td>
                          <td>{transaction.description || <span className="faint">No description</span>}{transaction.subscription_id && <div className="tiny faint">Linked subscription</div>}</td>
                          <td>{categoryName(transaction, budget)}{category?.kind === 'savings' && <div className="tiny faint">Savings contribution</div>}</td>
                          <td className="num">{money(transaction.amount_cents, currency)}</td>
                          <td><div className="finance-actions"><button type="button" className="btn btn-ghost btn-icon" onClick={() => openEditTransaction(transaction)} aria-label={`Edit ${transaction.description || 'transaction'}`}><Pencil /></button><button type="button" className="btn btn-ghost btn-icon" onClick={() => void deleteTransaction(transaction)} disabled={deletingId === transaction.id} aria-label={`Delete ${transaction.description || 'transaction'}`}>{deletingId === transaction.id ? <Spinner /> : <Trash2 />}</button></div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      <TransactionModal open={transactionOpen} transaction={editingTransaction} month={selectedMonth} categories={budget?.categories ?? []} context={{ userId, currency }} onClose={() => setTransactionOpen(false)} onSaved={onRefresh} />
    </section>
  );
}
