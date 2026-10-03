"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, Check, Eye, FileUp, Landmark, Plus, Repeat, Wallet } from "lucide-react";
import { Card, Progress } from "@/components/kit";
import { useFinance } from "@/components/finance/FinanceProvider";
import { DailyBars } from "@/components/finance/charts";
import { TransactionEditor } from "@/components/finance/TransactionEditor";
import { CategoryTile, Hero, Pill, StatusChip, TxAmount, monthLong, relativeDay, shortDay } from "@/components/finance/kit";
import { compareDebtPlans } from "@/lib/debt-planner";
import { currentBudgetMonth, summarizeBudget } from "@/lib/budget-planner";
import { dailySpending, evaluateHealth, healthScore, monthActivity, netWorth } from "@/lib/finance-insights";
import { forecastSubscriptionCharges, forecastTotalCents } from "@/lib/subscription-planner";
import { categoryLookup, debtsMissingTerms, isEmptyWorkspace, payoffDebts, sortTransactions } from "@/lib/finance-selectors";
import { money } from "@/lib/format";
import type { FinanceTransaction } from "@/lib/finance-types";

export default function FinanceOverview() {
  const f = useFinance();
  const { bundle, currency, today } = f;
  const [editing, setEditing] = useState<{ tx: FinanceTransaction | null } | null>(null);
  const month = currentBudgetMonth(today);
  const cats = useMemo(() => categoryLookup(bundle.categories), [bundle.categories]);

  const view = useMemo(() => {
    const worth = netWorth(bundle.accounts, bundle.holdings);
    const budget = bundle.budgets.find((b) => b.month === month);
    const summary = summarizeBudget({ month, today, budget, categories: bundle.categories, transactions: bundle.transactions, settings: bundle.settings });
    const activity = monthActivity(bundle.transactions, bundle.categories, month);
    const topCategories = Object.entries(activity.byCategory)
      .map(([id, cents]) => ({ category: cats.get(id), cents }))
      .filter((x) => x.category && x.category.kind !== "savings" && x.cents > 0)
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 4);
    const daily = dailySpending(bundle.transactions, bundle.categories, today, 30);
    const rules = evaluateHealth({ settings: bundle.settings, accounts: bundle.accounts, holdings: bundle.holdings, categories: bundle.categories, transactions: bundle.transactions, today, currency });
    const known = rules.filter((r) => r.status !== "unknown").length;
    const charges = forecastSubscriptionCharges(bundle.subscriptions, today, 14);
    const debts = payoffDebts(bundle.accounts);
    let payoff: string | null = null;
    if (debts.length) {
      try {
        const plan = compareDebtPlans({ debts, strategy: "avalanche", extra_monthly_cents: 0, first_payment_month: today.slice(0, 7) }).plan;
        payoff = plan.is_finite ? plan.payoff_month : null;
      } catch { payoff = null; }
    }
    return { worth, summary, activity, topCategories, daily, rules, known, score: known >= 3 ? healthScore(rules) : null, charges, chargesTotal: Number(forecastTotalCents(charges)), debts, payoff };
  }, [bundle, month, today, currency, cats]);

  if (isEmptyWorkspace(bundle)) return <Welcome />;

  const { worth, summary, activity } = view;
  const recent = sortTransactions(bundle.transactions).slice(0, 6);
  const missingTerms = debtsMissingTerms(bundle.accounts);
  const spendLimit = summary.spending_limit_cents;

  return (
    <>
      {bundle.accounts.length ? (
        <Hero label="Net worth" cents={worth.net} currency={currency} tone="auto"
          actions={<><button type="button" className="btn btn-primary" onClick={() => setEditing({ tx: null })}><Plus /> Add transaction</button>
            <Link href="/finance/accounts" className="btn"><Wallet /> Accounts</Link></>}>
          <Pill color="var(--pos)" label="Cash" value={money(worth.liquid, currency)} />
          {worth.investments > 0 && <Pill color="var(--chart-2)" label="Investments" value={money(worth.investments, currency)} />}
          {worth.liabilities > 0 && <Pill color="var(--neg)" label="Debt" value={money(worth.liabilities, currency)} />}
        </Hero>
      ) : (
        <Hero label={`Spent in ${monthLong(month).split(" ")[0]}`} cents={summary.spent_cents} currency={currency}
          actions={<><button type="button" className="btn btn-primary" onClick={() => setEditing({ tx: null })}><Plus /> Add transaction</button>
            <Link href="/finance/accounts" className="btn"><Wallet /> Add accounts</Link></>}
          note="Add your accounts to see net worth.">
          <Pill color="var(--pos)" label="In" value={money(activity.income, currency)} />
          <Pill color="var(--chart-3)" label="Saved" value={money(activity.savings, currency)} />
        </Hero>
      )}

      <div className="dash-grid">
        <div className="dash-col">
          <Card title={monthLong(month)} description={summary.is_set_up ? "Against your plan" : "No plan yet for this month"}
            action={<Link href="/finance/budget" className="btn btn-sm">{summary.is_set_up ? "Budget" : "Plan it"} <ArrowRight /></Link>}>
            <div className="fin-kpis" style={{ margin: "-4px -18px 14px", borderTop: 0, borderBottom: "1px solid var(--line)" }}>
              <div><div className="k">In</div><div className="v num pos">{money(activity.income, currency)}</div></div>
              <div><div className="k">Spent</div><div className="v num">{money(summary.spent_cents, currency)}</div></div>
              <div><div className="k">Saved</div><div className="v num">{money(summary.saved_cents, currency)}</div></div>
            </div>
            {spendLimit > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Progress value={summary.spent_cents} max={spendLimit} tone={summary.spent_cents > spendLimit ? "neg" : "pos"} />
                <div className="fin-row-meta"><span>{money(summary.spent_cents, currency)} of {money(spendLimit, currency)} planned</span><span>{paceLine(summary, currency)}</span></div>
              </div>
            )}
            {view.topCategories.length ? (
              <div className="list">
                {view.topCategories.map(({ category, cents }) => (
                  <div className="item" key={category!.id}>
                    <CategoryTile category={category} size="sm" />
                    <div className="item-main"><div className="item-title">{category!.name}</div></div>
                    <div className="item-end"><div className="v">{money(cents, currency)}</div></div>
                  </div>
                ))}
              </div>
            ) : <p className="hint">No spending logged this month yet.</p>}
          </Card>

          <Card title="Last 30 days" description="Daily spending, excluding savings and transfers">
            <DailyBars data={view.daily} currency={currency} />
          </Card>

          <Card title="Recent activity" action={<Link href="/finance/activity" className="btn btn-sm">All <ArrowRight /></Link>}>
            {recent.length ? (
              <div className="list">
                {recent.map((t) => {
                  const c = t.category_id ? cats.get(t.category_id) : null;
                  return (
                    <button type="button" className="item clickable" key={t.id} onClick={() => setEditing({ tx: t })}>
                      <CategoryTile category={c} income={t.kind === "income"} transfer={t.kind === "transfer"} />
                      <div className="item-main">
                        <div className="item-title">{t.description}</div>
                        <div className="item-sub">{relativeDay(t.date, today)} · {t.kind === "expense" ? c?.name ?? "Uncategorized" : t.kind === "income" ? "Income" : "Transfer"}</div>
                      </div>
                      <div className="item-end"><div className="v"><TxAmount tx={t} currency={currency} /></div></div>
                    </button>
                  );
                })}
              </div>
            ) : <p className="hint">Nothing logged yet. Add a transaction or import a CSV from your bank.</p>}
          </Card>
        </div>

        <div className="dash-col">
          <Card title="Financial health" action={<Link href="/finance/health" className="btn btn-sm">Details <ArrowRight /></Link>}>
            <div className="row-flex" style={{ gap: 16, alignItems: "center", marginBottom: 10 }}>
              <div className="fin-score" style={{ ["--p" as string]: view.score ?? 0, ["--c" as string]: scoreColor(view.score), width: 76, height: 76 }}>
                <div style={{ width: 62, height: 62 }}><b style={{ fontSize: 24 }}>{view.score ?? "–"}</b></div>
              </div>
              <div className="min0">
                <div style={{ fontWeight: 600 }}>{view.score === null ? "Add your numbers" : view.score >= 80 ? "Strong month" : view.score >= 50 ? "A few things to tighten" : "Needs attention"}</div>
                <div className="hint">{view.score === null ? "Income and accounts unlock the six checks." : `${view.known} of 6 checks scored`}</div>
              </div>
            </div>
            <div className="list">
              {view.rules.slice(0, 4).map((r) => (
                <div className="item" key={r.id} style={{ padding: "9px 0" }}>
                  <div className="item-main"><div className="item-title" style={{ fontSize: 13.5 }}>{r.name}</div></div>
                  <StatusChip status={r.status} />
                </div>
              ))}
            </div>
            {view.score === null && <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => f.settings.show("profile")}>Add income details</button>}
          </Card>

          <Card title="Coming up" description={view.charges.length ? `${money(view.chargesTotal, currency)} in the next 14 days` : "Next 14 days"}
            action={<Link href="/finance/subscriptions" className="btn btn-sm">Subscriptions <ArrowRight /></Link>}>
            {view.charges.length ? (
              <div className="list">
                {view.charges.slice(0, 5).map((c) => (
                  <div className="item" key={`${c.subscription_id}-${c.date}`}>
                    <span className="icon-tile sm"><Repeat /></span>
                    <div className="item-main"><div className="item-title">{c.name}</div><div className="item-sub">{relativeDay(c.date, today)} · {shortDay(c.date)}</div></div>
                    <div className="item-end"><div className="v">{money(c.amount_cents, currency)}</div></div>
                  </div>
                ))}
              </div>
            ) : <p className="hint">{bundle.subscriptions.length ? "No renewals in the next two weeks." : "Track subscriptions to see renewals before they hit."}</p>}
          </Card>

          <Card title="Debt" action={<Link href="/finance/debt" className="btn btn-sm">Payoff plan <ArrowRight /></Link>}>
            {view.debts.length ? (
              <div className="row-flex" style={{ gap: 14 }}>
                <span className="icon-tile"><Landmark /></span>
                <div className="min0">
                  <div className="num" style={{ fontSize: 18 }}>{money(view.debts.reduce((a, d) => a + d.balance_cents, 0), currency)}</div>
                  <div className="hint">{view.payoff ? `Debt-free by ${monthLong(view.payoff)} on minimums` : "Minimums don't cover interest yet"}</div>
                </div>
              </div>
            ) : <p className="hint">{missingTerms.length ? `Add the APR and minimum for ${missingTerms.map((a) => a.name).join(", ")} to plan a payoff.` : "No debts tracked. Add credit cards or loans in Accounts."}</p>}
          </Card>
        </div>
      </div>

      <TransactionEditor open={editing !== null} tx={editing?.tx ?? null} onClose={() => setEditing(null)} />
    </>
  );
}

function scoreColor(score: number | null) {
  return score === null ? "var(--surface-3)" : score >= 80 ? "var(--pos)" : score >= 50 ? "var(--gold)" : "var(--neg)";
}

/** Pace only for flexible spending (wants with a limit), so rent on the 1st never reads as overspending. */
function paceLine(summary: ReturnType<typeof summarizeBudget>, currency: string): string {
  const flex = summary.flexible;
  if (!flex) return "";
  const pace = flex.pace;
  if (pace.status === "past" || pace.status === "future") return "";
  if (pace.safePerDayCents !== null && pace.status !== "over") return `${money(pace.safePerDayCents, currency)}/day for wants`;
  return `Wants on pace for ${money(pace.projectedCents, currency)}`;
}

function Welcome() {
  const { bundle, setDemo, settings } = useFinance();
  const steps = [
    { done: !!bundle.settings?.monthly_net_cents, title: "Add your income", body: "Gross and take-home pay power your budget and the six health checks.", action: <button type="button" className="btn btn-sm btn-primary" onClick={() => settings.show("profile")}>Add income</button> },
    { done: bundle.accounts.length > 0 || bundle.transactions.length > 0, title: "Bring in your money", body: "Add accounts by hand, import a CSV from any bank, or link a bank where it's available.", action: (
      <div className="row-flex wrap" style={{ gap: 6 }}>
        <Link href="/finance/accounts" className="btn btn-sm"><Wallet /> Add accounts</Link>
        <Link href="/finance/activity?import=1" className="btn btn-sm"><FileUp /> Import CSV</Link>
      </div>
    ) },
    { done: bundle.budgets.some((b) => b.limits.length > 0), title: "Plan this month", body: "Give every dollar of take-home a job with a 50/30/20 starter you can adjust.", action: <Link href="/finance/budget" className="btn btn-sm">Open budget</Link> },
  ];
  return (
    <section className="card">
      <div className="card-body" style={{ padding: "28px 22px" }}>
        <div className="serif" style={{ fontSize: 32, lineHeight: 1.1 }}>Set up your money.</div>
        <p className="muted" style={{ marginTop: 8, maxWidth: 560 }}>Budget, accounts, debt payoff, subscriptions and health checks in one private place. Free, and nothing is shared with your groups.</p>
        <div className="list" style={{ marginTop: 18 }}>
          {steps.map((s, i) => (
            <div className="item" key={s.title} style={{ alignItems: "flex-start" }}>
              <span className={`icon-tile ${s.done ? "fin-in" : "gold"}`}>{s.done ? <Check /> : <b style={{ fontSize: 13 }}>{i + 1}</b>}</span>
              <div className="item-main">
                <div className="item-title" style={{ whiteSpace: "normal" }}>{s.title}</div>
                <div className="hint" style={{ marginTop: 2 }}>{s.body}</div>
                <div style={{ marginTop: 10 }}>{s.action}</div>
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-ghost" style={{ marginTop: 14 }} onClick={() => setDemo(true)}><Eye /> Explore with sample data first</button>
      </div>
    </section>
  );
}
