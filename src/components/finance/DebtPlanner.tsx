"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { Empty, Modal, Segmented } from "@/components/ui";
import { compareDebtPlans, type DebtPlan, type DebtStrategy } from "@/lib/debt-planner";
import { financeApi } from "@/lib/finance-data";
import { FINANCE_MAX_CENTS, type FinanceContext, type FinanceToolProps, type PersonalDebt } from "@/lib/finance-types";
import { centsToInput, money, moneyShort, monthLabel } from "@/lib/format";
import { parseMoney } from "@/lib/split";

const SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_FIRST_PAYMENT_YEAR = 9949;

type DebtDraft = { name: string; balance: string; apr: string; minimum: string };
const EMPTY_DRAFT: DebtDraft = { name: "", balance: "", apr: "", minimum: "" };

function currentMonth(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function parseAprBps(value: string): number | null {
  const text = value.trim();
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(bps) && bps >= 0 && bps <= 100_000 ? bps : null;
}

function formatCents(cents: bigint, currency: string): string {
  if (cents <= SAFE_BIGINT && cents >= -SAFE_BIGINT) return money(Number(cents), currency);
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const fraction = String(magnitude % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}${currency} ${whole.toLocaleString("en-US")}.${fraction}`;
}

function formatPlanMonth(value: string | null): string {
  return value ? monthLabel(`${value}-01`) : "Not available";
}

function chartValue(value: bigint): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_VALUE;
}

function compactTimeline(plan: DebtPlan) {
  const every = Math.max(1, Math.ceil(plan.timeline.length / 72));
  const rows = plan.timeline.filter((_, index) => index % every === 0);
  const last = plan.timeline.at(-1);
  if (last && rows.at(-1)?.month_number !== last.month_number) rows.push(last);
  return rows.map((row) => ({ label: row.month.slice(2), balance: chartValue(row.ending_balance_cents) }));
}

export function DebtPlanner({ bundle, currency, userId, onRefresh }: FinanceToolProps) {
  const [strategy, setStrategy] = useState<DebtStrategy>("avalanche");
  const [extra, setExtra] = useState("");
  const [firstPaymentMonth, setFirstPaymentMonth] = useState(currentMonth);
  const [editing, setEditing] = useState<PersonalDebt | "new" | null>(null);
  const [editContext, setEditContext] = useState<FinanceContext | null>(null);
  const [draft, setDraft] = useState<DebtDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  const extraCents = extra.trim() ? parseMoney(extra) : 0;
  const validExtra = extraCents !== null && extraCents >= 0 && extraCents <= FINANCE_MAX_CENTS;
  const validMonth = /^(\d{4})-(0[1-9]|1[0-2])$/.test(firstPaymentMonth)
    && Number(firstPaymentMonth.slice(0, 4)) >= 1
    && Number(firstPaymentMonth.slice(0, 4)) <= MAX_FIRST_PAYMENT_YEAR;
  const activeDebts = useMemo(() => bundle.debts.filter((debt) => debt.balance_cents > 0), [bundle.debts]);
  const result = useMemo(() => {
    if (!activeDebts.length || !validExtra || !validMonth) return null;
    try {
      return compareDebtPlans({
        debts: activeDebts.map(({ id, name, balance_cents, apr_bps, minimum_cents }) => ({ id, name, balance_cents, apr_bps, minimum_cents })),
        strategy,
        extra_monthly_cents: extraCents ?? 0,
        first_payment_month: firstPaymentMonth,
      });
    } catch {
      return null;
    }
  }, [activeDebts, extraCents, firstPaymentMonth, strategy, validExtra, validMonth]);

  const openDebt = (debt?: PersonalDebt) => {
    const context = { userId, currency };
    if (debt && debt.user_id !== context.userId) {
      setActionError("Your finance account changed. Reload and reopen the debt before editing it.");
      return;
    }
    setEditing(debt ?? "new");
    setEditContext(context);
    setDraft(debt ? {
      name: debt.name,
      balance: centsToInput(debt.balance_cents),
      apr: (debt.apr_bps / 100).toFixed(2),
      minimum: centsToInput(debt.minimum_cents),
    } : EMPTY_DRAFT);
    setFormError(null);
    setActionError(null);
  };

  const closeDebt = () => {
    if (busy) return;
    setEditing(null);
    setEditContext(null);
    setFormError(null);
  };

  const saveDebt = async (event: FormEvent) => {
    event.preventDefault();
    if (!editContext || editContext.userId !== userId || editContext.currency !== currency) {
      return setFormError("Your finance account or currency changed. Close and reopen this debt before saving.");
    }
    if (editing !== "new" && editing?.user_id !== editContext.userId) {
      return setFormError("This debt belongs to a different finance account. Close and reopen it before saving.");
    }
    const balance = parseMoney(draft.balance);
    const minimum = parseMoney(draft.minimum);
    const aprBps = parseAprBps(draft.apr);
    if (!draft.name.trim()) return setFormError("Enter a debt name");
    if (balance === null || balance <= 0 || balance > FINANCE_MAX_CENTS) return setFormError("Enter a positive balance up to 10,000,000,000.00. Remove a debt once it is paid off.");
    if (minimum === null || minimum <= 0 || minimum > FINANCE_MAX_CENTS) return setFormError("Minimum payment must be greater than zero");
    if (aprBps === null) return setFormError("APR must be from 0% to 1000%, with up to two decimal places");
    setBusy(true);
    setFormError(null);
    try {
      await financeApi.saveDebt({
        id: editing !== "new" && editing ? editing.id : undefined,
        name: draft.name.trim(),
        balance_cents: balance,
        apr_bps: aprBps,
        minimum_cents: minimum,
      }, editContext);
      await onRefresh();
      setEditing(null);
      setEditContext(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeDebt = async (debt: PersonalDebt) => {
    const context = { userId, currency };
    if (!window.confirm(`Delete ${debt.name}? This removes the saved debt from this private finance tool.`)) return;
    if (debt.user_id !== context.userId) {
      setActionError("Your finance account changed. Reload before deleting this debt.");
      return;
    }
    setActionError(null);
    try {
      await financeApi.deleteDebt(debt.id, context);
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const plan = result?.plan ?? null;
  const chartData = plan ? compactTimeline(plan) : [];
  const staleEditContext = editContext !== null && (editContext.userId !== userId || editContext.currency !== currency);

  return (
    <div className="finance-tool stack">
      <section className="card">
        <div className="card-head">
          <div><div className="card-title">Your debts</div><div className="card-desc">Stored privately in your SPLITTER account.</div></div>
          <button type="button" className="btn btn-primary" onClick={() => openDebt()}>Add debt</button>
        </div>
        <div className="card-body stack-sm">
          {!bundle.debts.length ? (
            <Empty title="No debts added" action={<button type="button" className="btn" onClick={() => openDebt()}>Add your first debt</button>}>
              Add real balances, APRs, and minimums to calculate a payoff plan. No sample or placeholder debts are created.
            </Empty>
          ) : bundle.debts.map((debt) => (
            <div className="finance-list-row" key={debt.id}>
              <div>
                <b>{debt.name}</b>
                <div className="hint">{(debt.apr_bps / 100).toFixed(2)}% APR · {money(debt.minimum_cents, currency)} minimum</div>
              </div>
              <div className="finance-actions">
                <span className="num">{money(debt.balance_cents, currency)}</span>
                <button type="button" className="btn btn-sm" onClick={() => openDebt(debt)}>Edit</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void removeDebt(debt)}>Delete</button>
              </div>
            </div>
          ))}
          {actionError && <div className="banner neg">{actionError}</div>}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><div><div className="card-title">Payoff plan</div><div className="card-desc">Minimums continue and each freed payment rolls into the next target.</div></div></div>
        <div className="card-body stack">
          <div className="finance-grid">
            <div className="field">
              <span className="label">Strategy</span>
              <Segmented<DebtStrategy> block value={strategy} onChange={setStrategy} options={[
                { id: "avalanche", label: "Avalanche" },
                { id: "snowball", label: "Snowball" },
              ]} />
              <span className="hint">{strategy === "avalanche" ? "Highest APR first, usually minimizing interest." : "Smallest current balance first, creating earlier account wins."}</span>
            </div>
            <div className="field">
              <label className="label" htmlFor="debt-extra">Extra each month <span className="faint">{currency}</span></label>
              <input id="debt-extra" className="input" inputMode="decimal" value={extra} onChange={(event) => setExtra(event.target.value)} placeholder="0.00" />
              {!validExtra && <span className="hint neg">Enter an amount from 0 to 10,000,000,000.00.</span>}
            </div>
            <div className="field">
              <label className="label" htmlFor="debt-start">First payment month</label>
              <input id="debt-start" className="input" type="month" min="0001-01" max="9949-12" value={firstPaymentMonth} onChange={(event) => setFirstPaymentMonth(event.target.value)} />
              {!validMonth && <span className="hint neg">Choose a valid month through December 9949.</span>}
            </div>
          </div>
          <p className="hint">Strategy, extra payment, and first payment month are what-if settings only. They are not saved and reset when this tool reloads.</p>

          {!activeDebts.length ? (
            <Empty title={bundle.debts.length ? "No outstanding balances" : "Add debts to build a plan"}>
              {bundle.debts.length ? "Every saved balance is zero." : "The calculator uses only debts you add and never sends these values to a model or bank."}
            </Empty>
          ) : result && plan && (
            <>
              {plan.status === "negative_amortization" && (
                <div className="banner neg">This monthly budget does not keep up with accruing interest under this strategy. The balance is not projected to be paid off, so savings and a debt-free date are not shown.</div>
              )}
              {plan.status === "month_limit" && (
                <div className="banner">The balance is declining, but payoff takes more than the 600-month calculation limit. Savings and a debt-free date are not shown.</div>
              )}

              <div className="finance-stats">
                <div className="finance-stat"><span className="hint">Total balance</span><strong className="num">{formatCents(plan.total_balance_cents, currency)}</strong></div>
                <div className="finance-stat"><span className="hint">Monthly commitment</span><strong className="num">{formatCents(plan.monthly_commitment_cents, currency)}</strong></div>
                <div className="finance-stat"><span className="hint">Estimated interest</span><strong className="num">{plan.is_finite ? formatCents(plan.estimated_interest_cents, currency) : "Not available"}</strong></div>
                <div className="finance-stat"><span className="hint">Debt-free estimate</span><strong>{formatPlanMonth(plan.payoff_month)}</strong></div>
              </div>

              {result.interest_saved_cents !== null && result.months_saved !== null && (extraCents ?? 0) > 0 && (
                <div className="banner">Compared with minimum payments only, this plan estimates {formatCents(result.interest_saved_cents, currency)} less interest and {result.months_saved} fewer month{result.months_saved === 1 ? "" : "s"}.</div>
              )}
              {(extraCents ?? 0) > 0 && result.baseline.is_finite === false && (
                <p className="hint">The minimum-only baseline does not finish within 600 months, so interest and time saved are not claimed.</p>
              )}

              <div className="finance-grid">
                <section className="card">
                  <div className="card-head"><div className="card-title">Balance timeline</div></div>
                  <div className="card-body">
                    <div role="img" aria-label={`Projected remaining debt balance by month for the ${strategy} plan`} style={{ width: "100%", height: 260 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                          <CartesianGrid vertical={false} stroke="var(--line)" />
                          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--line-2)" }} tick={{ fill: "var(--ink-3)", fontSize: 11 }} />
                          <YAxis width={56} tickLine={false} axisLine={false} tick={{ fill: "var(--ink-3)", fontSize: 11 }} tickFormatter={(value) => moneyShort(Number(value), currency)} />
                          <Area type="monotone" dataKey="balance" stroke="var(--gold)" fill="var(--gold-wash)" strokeWidth={2} isAnimationActive={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </section>

                <section className="card">
                  <div className="card-head"><div className="card-title">Payoff order</div></div>
                  <div className="card-body stack-sm">
                    {plan.payoff_order.length ? plan.payoff_order.map((payoff) => (
                      <div className="finance-list-row" key={payoff.debt_id}>
                        <span><b>{payoff.order}. {payoff.name}</b><span className="hint">{formatPlanMonth(payoff.payoff_month)}</span></span>
                        <span className="num">{formatCents(payoff.interest_cents, currency)} interest</span>
                      </div>
                    )) : <p className="hint">No debt reaches payoff within the calculated period.</p>}
                  </div>
                </section>
              </div>

              <div className="between">
                <div><b>Monthly amortization</b><div className="hint">Interest is applied first, then payments, using exact cent rounding.</div></div>
                <button type="button" className="btn" aria-expanded={showSchedule} onClick={() => setShowSchedule((shown) => !shown)}>{showSchedule ? "Hide schedule" : "Show schedule"}</button>
              </div>
              {showSchedule && (
                <div className="finance-scroll">
                  <table className="finance-table">
                    <caption className="sr-only">Monthly debt payoff amortization</caption>
                    <thead><tr><th scope="col">Month</th><th scope="col">Opening</th><th scope="col">Interest</th><th scope="col">Payment</th><th scope="col">Remaining</th></tr></thead>
                    <tbody>{plan.timeline.map((row) => (
                      <tr key={row.month_number}><th scope="row">{formatPlanMonth(row.month)}</th><td>{formatCents(row.opening_balance_cents, currency)}</td><td>{formatCents(row.interest_cents, currency)}</td><td>{formatCents(row.payment_cents, currency)}</td><td>{formatCents(row.ending_balance_cents, currency)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="card"><div className="card-body stack-sm">
        <b>How this estimate works</b>
        <p className="hint">APR is treated as a nominal annual rate divided across 12 months. Monthly interest rounds half up to the nearest cent. Minimums are paid first, then the remaining fixed monthly budget goes to the selected target. A final payment is capped at the amount due.</p>
        <p className="hint">This is a planning calculator, not debt forgiveness or financial advice. Actual statement timing, daily interest, variable rates, promotional terms, fees, and lender payment rules can change the result.</p>
        <p className="hint">There is no bank sync. Calculations do not automatically log payments, change balances, or send your private money data to an AI model.</p>
      </div></section>

      <Modal open={editing !== null} onClose={closeDebt} title={editing === "new" ? "Add debt" : "Edit debt"}
        footer={<><button type="button" className="btn btn-ghost" onClick={closeDebt}>Cancel</button><button type="submit" form="debt-form" className="btn btn-primary" disabled={busy || staleEditContext || !editContext}>{busy ? "Saving..." : "Save debt"}</button></>}>
        <form id="debt-form" className="stack" onSubmit={saveDebt}>
          <div className="field"><label className="label" htmlFor="debt-name">Name</label><input id="debt-name" className="input" value={draft.name} maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Credit card, student loan..." /></div>
          <div className="form-row">
            <div className="field"><label className="label" htmlFor="debt-balance">Balance <span className="faint">{editContext?.currency ?? currency}</span></label><input id="debt-balance" className="input" inputMode="decimal" value={draft.balance} onChange={(event) => setDraft({ ...draft, balance: event.target.value })} placeholder="0.00" /></div>
            <div className="field"><label className="label" htmlFor="debt-minimum">Minimum payment <span className="faint">{editContext?.currency ?? currency}</span></label><input id="debt-minimum" className="input" inputMode="decimal" value={draft.minimum} onChange={(event) => setDraft({ ...draft, minimum: event.target.value })} placeholder="0.00" /></div>
          </div>
          <div className="field"><label className="label" htmlFor="debt-apr">APR percentage</label><input id="debt-apr" className="input" inputMode="decimal" value={draft.apr} onChange={(event) => setDraft({ ...draft, apr: event.target.value })} placeholder="0.00" /><span className="hint">0% is valid. Maximum 1000%, with up to two decimal places.</span></div>
          <p className="hint">The minimum must be positive, but it may be greater than the remaining balance. The calculator caps the final payment.</p>
          {staleEditContext && <div className="banner neg">Your finance account or currency changed. Close and reopen this debt before saving.</div>}
          {formError && <div className="banner neg">{formError}</div>}
        </form>
      </Modal>
    </div>
  );
}

export default DebtPlanner;
