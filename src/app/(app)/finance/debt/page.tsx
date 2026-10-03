"use client";
import "@/components/finance/styles/debt.css";
import { useMemo, useState } from "react";
import { CircleAlert, Plus } from "lucide-react";
import { Card } from "@/components/kit";
import { Empty } from "@/components/ui";
import { useFinance } from "@/components/finance/FinanceProvider";
import { AccountEditor } from "@/components/finance/AccountEditor";
import { DebtSchedule } from "@/components/finance/DebtSchedule";
import { PayoffChart } from "@/components/finance/charts";
import { AccountIcon, AmountChips, HeroText, MoneyInput, Pill, currencySymbol, monthLong, monthShort } from "@/components/finance/kit";
import { compareDebtPlans, type DebtPlan, type DebtPlanComparison, type DebtStrategy } from "@/lib/debt-planner";
import { debtsMissingTerms, payoffDebts } from "@/lib/finance-selectors";
import { centsToInput, money } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { FINANCE_MAX_CENTS, isLiability, type FinanceAccount, type FinanceAccountInput } from "@/lib/finance-types";

function bigMoney(c: bigint, currency: string): string {
  const n = Number(c);
  if (Number.isSafeInteger(n)) return money(n, currency);
  return `${currencySymbol(currency)}${(c / 100n).toLocaleString("en-US")}`;
}

function presets(minimums: number): number[] {
  const nice = (v: number) => { const step = v < 10_000 ? 2_500 : v < 50_000 ? 5_000 : 10_000; return Math.max(step, Math.round(v / step) * step); };
  const out = [0, nice(minimums * 0.1), nice(minimums * 0.25), nice(minimums * 0.5), nice(minimums)];
  return [...new Set(out)].sort((a, b) => a - b).slice(0, 5);
}

const STRATEGY_NAME: Record<DebtStrategy, string> = { avalanche: "Avalanche", snowball: "Snowball" };
const STRATEGY_RULE: Record<DebtStrategy, string> = { avalanche: "Highest APR first", snowball: "Smallest balance first" };

type Editing = { account: FinanceAccount | null; defaults?: Partial<FinanceAccountInput> };

export default function DebtPage() {
  const { bundle, currency, today } = useFinance();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [strategy, setStrategy] = useState<DebtStrategy | null>(null);
  const [extraText, setExtraText] = useState("");

  const parsed = parseMoney(extraText);
  const extraInvalid = extraText.trim() !== "" && parsed === null;
  const extra = Math.min(Math.max(parsed ?? 0, 0), FINANCE_MAX_CENTS);

  const view = useMemo(() => {
    const liabilities = bundle.accounts.filter((a) => isLiability(a.type));
    const debts = payoffDebts(bundle.accounts);
    const missing = debtsMissingTerms(bundle.accounts);
    const month = today.slice(0, 7);
    let avalanche: DebtPlanComparison | null = null;
    let snowball: DebtPlanComparison | null = null;
    let failed = false;
    if (debts.length) {
      try {
        avalanche = compareDebtPlans({ debts, strategy: "avalanche", extra_monthly_cents: extra, first_payment_month: month });
        snowball = compareDebtPlans({ debts, strategy: "snowball", extra_monthly_cents: extra, first_payment_month: month });
      } catch { failed = true; avalanche = null; snowball = null; }
    }
    let recommended: DebtStrategy = "avalanche";
    if (avalanche && snowball) {
      const a = avalanche.plan, s = snowball.plan;
      if (a.is_finite && s.is_finite) {
        if (s.estimated_interest_cents < a.estimated_interest_cents) recommended = "snowball";
        else if (s.estimated_interest_cents === a.estimated_interest_cents && (s.months ?? 0) < (a.months ?? 0)) recommended = "snowball";
      } else if (s.is_finite && !a.is_finite) recommended = "snowball";
    }
    const minimumsTotal = debts.reduce((sum, d) => sum + d.minimum_cents, 0);
    const sorted = [...liabilities].sort((x, y) => Number(y.in_payoff) - Number(x.in_payoff) || y.balance_cents - x.balance_cents);
    return { liabilities: sorted, debts, missing, avalanche, snowball, failed, recommended, minimumsTotal };
  }, [bundle.accounts, extra, today]);

  const { liabilities, debts, missing, avalanche, snowball, failed, recommended, minimumsTotal } = view;
  const effective: DebtStrategy = strategy ?? recommended;
  const chosen = effective === "avalanche" ? avalanche : snowball;
  const plan: DebtPlan | null = chosen?.plan ?? null;

  const chart = useMemo(() => {
    if (!plan || !plan.is_finite) return null;
    const series = debts.map((d) => ({ key: d.id, name: d.name }));
    const start: Record<string, number | string> = { label: "Now", ...Object.fromEntries(debts.map((d) => [d.id, d.balance_cents])) };
    const tl = plan.timeline;
    const step = Math.max(1, Math.ceil(tl.length / 120));
    const points = tl.filter((_, i) => i % step === step - 1 || i === tl.length - 1).map((m) => ({
      label: monthShort(m.month),
      ...Object.fromEntries(m.payments.map((p) => [p.debt_id, Number(p.ending_balance_cents)])),
    }));
    return { series, data: [start, ...points] as Record<string, number | string>[] };
  }, [plan, debts]);

  const editor = (
    <AccountEditor open={editing !== null} account={editing?.account ?? null} defaults={editing?.defaults} onClose={() => setEditing(null)} />
  );
  const addDebt = () => setEditing({ account: null, defaults: { type: "credit", in_payoff: true } });

  if (liabilities.length === 0) {
    return (
      <>
        <Card>
          <Empty title="No debts tracked" action={<button type="button" className="btn btn-primary" onClick={addDebt}><Plus /> Add debt</button>}>
            Add a credit card or loan to see your debt-free date and which one to pay first.
          </Empty>
        </Card>
        {editor}
      </>
    );
  }

  const hero = (() => {
    if (!plan || !chosen) {
      return <HeroText label="Debt-free by" value="Check your numbers"
        note="One of your debts has a balance, APR or minimum we can't plan with. Open it below and fix it." />;
    }
    const pills = (
      <>
        <Pill color="var(--neg)" label="Owed" value={bigMoney(plan.total_balance_cents, currency)} />
        {plan.status !== "negative_amortization" && <Pill label="Interest" value={bigMoney(plan.estimated_interest_cents, currency)} />}
        <Pill label="Per month" value={bigMoney(plan.monthly_commitment_cents, currency)} />
      </>
    );
    if (plan.is_finite && plan.payoff_month) {
      let note: string;
      if (extra > 0 && chosen.interest_saved_cents !== null) {
        const saved = bigMoney(chosen.interest_saved_cents, currency);
        const ms = chosen.months_saved ?? 0;
        note = ms > 0 ? `${ms === 1 ? "1 month" : `${ms} months`} sooner and ${saved} less interest than paying minimums only.` : `${saved} less interest than paying minimums only.`;
      } else if (extra === 0) {
        note = "Paying minimums only. Add a little extra below to see what it saves.";
      } else note = "";
      return <HeroText label="Debt-free by" value={monthLong(plan.payoff_month)} note={note || undefined}>{pills}</HeroText>;
    }
    if (plan.status === "negative_amortization") {
      return <HeroText label="Debt-free by" value="Not yet" note="Your payments don't cover the interest, so the balance grows. Add more each month or check your minimums.">{pills}</HeroText>;
    }
    return <HeroText label="Debt-free by" value="Over 50 years" note="At this pace it takes more than 50 years. Add more each month to see a payoff date.">{pills}</HeroText>;
  })();

  const options: DebtStrategy[] = ["avalanche", "snowball"];
  const optionBadge = (s: DebtStrategy): string | null => {
    if (s !== recommended) return null;
    const mine = (s === "avalanche" ? avalanche : snowball)?.plan;
    const other = (s === "avalanche" ? snowball : avalanche)?.plan;
    if (mine?.is_finite && other?.is_finite) {
      const diff = other.estimated_interest_cents - mine.estimated_interest_cents;
      if (diff > 0n) return `Saves ${bigMoney(diff, currency)}`;
    }
    return "Recommended";
  };

  return (
    <>
      {missing.length > 0 && (
        <div className="banner">
          <CircleAlert />
          <div className="min0">Add the APR and minimum payment for {missing.map((a) => a.name).join(", ")} to include {missing.length === 1 ? "it" : "them"} in your plan.</div>
          <button type="button" className="btn btn-sm" style={{ minHeight: 36 }} onClick={() => setEditing({ account: missing[0] })}>Add details</button>
        </div>
      )}

      {debts.length > 0 && hero}

      <div className="dash-grid">
        <div className="dash-col">
          {debts.length > 0 && (
            <>
              <Card title="Pick a strategy">
                <div className="stack">
                  <div className="fin-compare" role="group" aria-label="Payoff strategy">
                    {options.map((s) => {
                      const p = (s === "avalanche" ? avalanche : snowball)?.plan;
                      const badge = optionBadge(s);
                      return (
                        <button key={s} type="button" className={`fin-option ${effective === s ? "on" : ""}`} aria-pressed={effective === s} onClick={() => setStrategy(s)} style={{ minHeight: 36 }}>
                          <div className="t">{STRATEGY_NAME[s]}{badge && <span className="badge gold">{badge}</span>}</div>
                          <div className="d">{p?.is_finite && p.payoff_month ? monthShort(p.payoff_month) : "No end date"}</div>
                          <div className="s">{p?.is_finite ? `${STRATEGY_RULE[s]} · ${bigMoney(p.estimated_interest_cents, currency)} interest` : STRATEGY_RULE[s]}</div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="stack-sm">
                    <label className="label" htmlFor="fin-debt-extra">Extra each month</label>
                    <MoneyInput id="fin-debt-extra" value={extraText} onChange={setExtraText} currency={currency} />
                    <AmountChips values={presets(minimumsTotal)} currency={currency} current={extra} onPick={(c) => setExtraText(c ? centsToInput(c) : "")} />
                    {extraInvalid
                      ? <div className="hint neg">Enter an amount like 50 or 125.50.</div>
                      : <div className="hint">On top of {money(minimumsTotal, currency)} in minimums.</div>}
                  </div>
                </div>
              </Card>

              <Card title="Balances over time" description={`${STRATEGY_NAME[effective]} plan`}>
                {chart ? <PayoffChart data={chart.data} series={chart.series} currency={currency} height={240} />
                  : <p className="hint">The chart appears once there's a payoff date.</p>}
              </Card>

              {plan && (
                <Card title="Month by month">
                  <DebtSchedule plan={plan} debts={debts} currency={currency} />
                </Card>
              )}
            </>
          )}
        </div>
        <div className="dash-col">
          {debts.length > 0 && plan && !failed && (
            <Card title="Payoff order" description={`${plan.payoff_order.length} ${plan.payoff_order.length === 1 ? "debt" : "debts"}, paid off in this order`}>
              {plan.is_finite || plan.payoff_order.length > 0 ? (
                <div className="list">
                  {plan.payoff_order.map((o) => (
                    <div key={o.debt_id} className="item">
                      <span className="icon-tile sm"><b>{o.order}</b></span>
                      <div className="item-main">
                        <div className="item-title">{o.name}</div>
                        <div className="item-sub">Paid off {monthLong(o.payoff_month)}</div>
                      </div>
                      <div className="item-end"><div className="v">{bigMoney(o.interest_cents, currency)}</div><div className="k">interest</div></div>
                    </div>
                  ))}
                </div>
              ) : null}
              {!plan.is_finite && <p className="hint">Once your payments cover the interest, the order shows here.</p>}
            </Card>
          )}

          <Card title="Your debts" action={<button type="button" className="btn btn-sm" style={{ minHeight: 36 }} onClick={addDebt}><Plus /> Add debt</button>}>
            <div className="list">
              {liabilities.map((a) => {
                const missingTerms = a.apr_bps === null || a.minimum_cents === null || a.minimum_cents <= 0;
                let sub: React.ReactNode;
                if (a.balance_cents === 0) sub = "Paid off";
                else if (!a.in_payoff) sub = "Not in your plan";
                else if (missingTerms) sub = <span style={{ color: "var(--gold-text)" }}>Add APR and minimum</span>;
                else sub = `${(a.apr_bps! / 100).toFixed(2).replace(/\.00$/, "")}% APR · ${money(a.minimum_cents!, currency)} minimum`;
                return (
                  <button key={a.id} type="button" className="item clickable" onClick={() => setEditing({ account: a })}>
                    <AccountIcon type={a.type} />
                    <div className="item-main">
                      <div className="item-title">{a.name}{a.last4 ? ` ··${a.last4}` : ""}</div>
                      <div className="item-sub">{sub}</div>
                    </div>
                    <div className="item-end"><div className="v">{money(a.balance_cents, currency)}</div></div>
                  </button>
                );
              })}
            </div>
          </Card>
        </div>
      </div>

      <p className="fin-foot">Estimates use today's balances, APRs and minimums with interest added monthly. Your statements will differ a little.</p>
      {editor}
    </>
  );
}
