"use client";
import "@/components/finance/styles/budget.css";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, CircleHelp, Info, Pencil, TriangleAlert } from "lucide-react";
import { Card, Progress } from "@/components/kit";
import { CHART_COLORS, Donut } from "@/components/charts";
import { BudgetCategorySheet } from "@/components/finance/BudgetCategorySheet";
import { BudgetPlanEditor } from "@/components/finance/BudgetPlanEditor";
import { useFinance } from "@/components/finance/FinanceProvider";
import { CategoryTile, Hero, MoneyInput, Pill, moneyTight, monthLong } from "@/components/finance/kit";
import {
  addBudgetMonths, budgetInsights, copyLimits, currentBudgetMonth, monthFromInput, starterLimits, summarizeBudget,
  type BudgetInsight, type BudgetRow, type FlexiblePace, PACE_MIN_DAYS } from "@/lib/budget-planner";
import { CATEGORY_KIND_LABEL, type BudgetLimit, type CategoryKind } from "@/lib/finance-types";
import { payoffDebts } from "@/lib/finance-selectors";
import { subscriptionEquivalentTotals } from "@/lib/subscription-planner";
import { centsToInput, money } from "@/lib/format";
import { parseMoney } from "@/lib/split";

const KINDS: CategoryKind[] = ["needs", "wants", "savings"];
const INSIGHT_ICON = { good: CircleCheck, info: Info, warn: TriangleAlert, bad: CircleAlert } as const;

export default function BudgetPage() {
  const { bundle, currency, today } = useFinance();
  const thisMonth = currentBudgetMonth(today);
  const [month, setMonthState] = useState(thisMonth);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ initial: { income_cents: number; limits: BudgetLimit[] } | null } | null>(null);
  const [setupIncome, setSetupIncome] = useState<string | null>(null);

  const setMonth = (m: string) => { setSheetId(null); setSetupIncome(null); setMonthState(m); };

  const bounds = useMemo(() => {
    let first = bundle.transactions.length ? bundle.transactions[0].date.slice(0, 7) : "9999-12";
    for (const t of bundle.transactions) { const k = t.date.slice(0, 7); if (k < first) first = k; }
    for (const b of bundle.budgets) { const k = b.month.slice(0, 7); if (k < first) first = k; }
    const floor = addBudgetMonths(thisMonth, -24).slice(0, 7);
    const earliest = monthFromInput(first < floor ? first : floor) ?? addBudgetMonths(thisMonth, -24);
    return { earliest, latest: addBudgetMonths(thisMonth, 12) };
  }, [bundle.transactions, bundle.budgets, thisMonth]);

  const budget = bundle.budgets.find((b) => b.month === month);
  const prevMonth = addBudgetMonths(month, -1);
  const prev = bundle.budgets.find((b) => b.month === prevMonth);

  const view = useMemo(() => {
    const summary = summarizeBudget({ month, today, budget, categories: bundle.categories, transactions: bundle.transactions, settings: bundle.settings });
    const subsCat = bundle.categories.find((c) => !c.archived && c.name.trim().toLowerCase() === "subscriptions") ?? null;
    const subscriptionsMonthlyCents = subsCat
      ? Number(subscriptionEquivalentTotals(bundle.subscriptions.filter((s) => s.category_id === subsCat.id)).monthly_cents) : 0;
    const debtMinimumsCents = payoffDebts(bundle.accounts).reduce((a, d) => a + d.minimum_cents, 0);
    const insights = summary.pace.status === "future" ? [] : budgetInsights(summary, {
      subscriptionsMonthlyCents, debtMinimumsCents, categories: bundle.categories, format: (c) => money(c, currency), paceBasis: "flexible",
    });
    return { summary, insights };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, month, today, currency]);
  const { summary, insights } = view;

  const monthName = monthLong(month).split(" ")[0];
  const isCurrent = month === thisMonth;
  const isPast = month < thisMonth;
  const activeRow = sheetId ? summary.rows.find((r) => r.category.id === sheetId) ?? null : null;

  const donut = useMemo(() => {
    const items = summary.rows
      .filter((r) => r.category.kind !== "savings" && r.used_cents > 0)
      .map((r) => ({ key: r.category.id, name: r.category.name, value: r.used_cents, color: "" }));
    if (summary.uncategorized_cents > 0) items.push({ key: "uncategorized", name: "Uncategorized", value: summary.uncategorized_cents, color: "var(--surface-3)" });
    items.sort((a, b) => b.value - a.value);
    const top = items.slice(0, 5);
    const rest = items.slice(5).reduce((a, i) => a + i.value, 0);
    if (rest > 0) top.push({ key: "rest", name: "Everything else", value: rest, color: "" });
    return top.map((i, idx) => ({ ...i, color: i.color || CHART_COLORS[idx % CHART_COLORS.length] }));
  }, [summary.rows, summary.uncategorized_cents]);

  /* ---- hero ---- */
  let heroLabel: string;
  let heroCents: number;
  if (summary.spending_limit_cents > 0) {
    heroCents = summary.spending_limit_cents - summary.spent_cents;
    heroLabel = isCurrent ? "Left to spend this month" : isPast ? `Left in ${monthName}` : `Planned for ${monthName}`;
  } else if (summary.planned_income_cents > 0) {
    heroCents = summary.left_cents;
    heroLabel = isCurrent ? "Left to spend this month" : isPast ? `Left in ${monthName}` : `Planned for ${monthName}`;
  } else {
    heroCents = summary.spent_cents;
    heroLabel = `Spent in ${monthName}`;
  }
  const showSaved = summary.savings_limit_cents > 0 || summary.saved_cents > 0;
  const paceStatus = summary.pace.status;
  const note = isCurrent && summary.flexible && paceStatus !== "past" && paceStatus !== "future" ? paceNote(summary.flexible, currency) : null;

  /* ---- setup options ---- */
  const defaultIncome = bundle.settings && bundle.settings.monthly_net_cents > 0 ? centsToInput(bundle.settings.monthly_net_cents) : "";
  const incomeText = setupIncome ?? defaultIncome;
  const setupCents = parseMoney(incomeText) ?? 0;
  const copied = copyLimits(prev, bundle.categories);
  const copiedSum = copied.reduce((a, l) => a + l.limit_cents, 0);
  const hasCats = bundle.categories.some((c) => !c.archived);
  const prevName = monthLong(prevMonth).split(" ")[0];

  const rowsByKind = KINDS.map((kind) => {
    const rows = summary.rows.filter((r) => r.category.kind === kind);
    const used = rows.reduce((a, r) => a + r.used_cents, 0);
    const limited = rows.filter((r) => r.limit_cents !== null);
    return { kind, rows, used, limitSum: limited.reduce((a, r) => a + (r.limit_cents ?? 0), 0), hasLimits: limited.length > 0 };
  }).filter((g) => g.rows.length > 0);

  const ready = summary.ready_to_assign_cents;
  const month7 = month.slice(0, 7);

  function runInsight(i: BudgetInsight) {
    const a = i.action;
    if (!a) return null;
    const btn = { className: "btn btn-ghost btn-sm", style: { minHeight: 36 } };
    if (a.kind === "assign" && a.category_id) {
      const row = summary.rows.find((r) => r.category.id === a.category_id);
      return <button type="button" {...btn} onClick={() => (row ? setSheetId(row.category.id) : setPlan({ initial: null }))}>Adjust</button>;
    }
    if (a.kind === "assign" || a.kind === "plan") return <button type="button" {...btn} onClick={() => setPlan({ initial: null })}>Edit plan</button>;
    if (a.kind === "categorize") return <Link {...btn} href={`/finance/activity?category=uncategorized&month=${month7}`}>Review</Link>;
    if (a.kind === "subscriptions") return <Link {...btn} href="/finance/subscriptions">Subscriptions</Link>;
    return <Link {...btn} href="/finance/debt">Debt plan</Link>;
  }

  return (
    <>
      <div className="fin-bud-month">
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Previous month" disabled={month <= bounds.earliest}
          onClick={() => setMonth(addBudgetMonths(month, -1))}><ChevronLeft /></button>
        <h2 className="fin-bud-mlabel">{monthLong(month)}</h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Next month" disabled={month >= bounds.latest}
          onClick={() => setMonth(addBudgetMonths(month, 1))}><ChevronRight /></button>
        {!isCurrent && <button type="button" className="btn btn-sm" onClick={() => setMonth(thisMonth)}>This month</button>}
      </div>

      <Hero label={heroLabel} cents={heroCents} currency={currency} tone="auto" note={note}
        actions={<>
          {summary.is_set_up && <button type="button" className="btn btn-primary" onClick={() => setPlan({ initial: null })}><Pencil /> Edit plan</button>}
          <Link className="btn" href="/finance/activity">Activity</Link>
        </>}>
        {summary.planned_income_cents > 0 && (
          <Pill color="var(--pos)" label={summary.income_source === "profile" ? "Income (from profile)" : "Income"} value={money(summary.planned_income_cents, currency)} />
        )}
        <Pill label="Spent" value={money(summary.spent_cents, currency)} />
        {showSaved && <Pill color="var(--chart-3)" label="Saved" value={money(summary.saved_cents, currency)} />}
      </Hero>

      {!summary.is_set_up && (
        <Card title={`Plan ${monthLong(month)}`} description={isPast ? "No plan for this month. You can still add one." : "Give every dollar of take-home a job."}>
          <div className="stack">
            <div className="field">
              <label className="label" htmlFor="fin-bud-income">Take-home this month</label>
              <MoneyInput id="fin-bud-income" currency={currency} value={incomeText} onChange={setSetupIncome} label="Take-home this month" />
              <div className="hint">Your pay after tax. Change it any time.</div>
            </div>
            <div className="fin-compare fin-bud-three">
              <button type="button" className="fin-option" disabled={setupCents <= 0 || !hasCats}
                onClick={() => setPlan({ initial: { income_cents: setupCents, limits: starterLimits({ incomeCents: setupCents, categories: bundle.categories }) } })}>
                <div className="t">50/30/20 starter</div>
                <div className="s">{setupCents <= 0 ? "Add your take-home first" : "Half to needs, 30% to wants, 20% to savings"}</div>
              </button>
              <button type="button" className="fin-option" disabled={copied.length === 0}
                onClick={() => setPlan({ initial: { income_cents: setupCents, limits: copied } })}>
                <div className="t">Copy {prevName}</div>
                <div className="s">{copied.length === 0 ? "Nothing to copy" : `${copied.length} ${copied.length === 1 ? "limit" : "limits"}, ${money(copiedSum, currency)}`}</div>
              </button>
              <button type="button" className="fin-option" onClick={() => setPlan({ initial: { income_cents: setupCents, limits: [] } })}>
                <div className="t">Start blank</div>
                <div className="s">Set each limit yourself</div>
              </button>
            </div>
          </div>
        </Card>
      )}

      <div className="dash-grid">
        <div className="dash-col">
          {insights.length > 0 && (
            <Card title="What to look at">
              {insights.map((i) => {
                const Icon = INSIGHT_ICON[i.tone];
                const action = runInsight(i);
                return (
                  <div className={`fin-insight ${i.tone}`} key={i.id}>
                    <Icon aria-hidden />
                    <div className="min0"><div className="t">{i.title}</div><div className="d">{i.detail}</div></div>
                    {action && <div style={{ marginLeft: "auto" }}>{action}</div>}
                  </div>
                );
              })}
            </Card>
          )}

          {rowsByKind.map((g) => (
            <Card key={g.kind} title={CATEGORY_KIND_LABEL[g.kind]}
              description={g.hasLimits ? `${money(g.used, currency)} of ${money(g.limitSum, currency)}` : `${money(g.used, currency)} spent, no limits`}>
              <div className="list">
                {g.rows.map((r) => <CategoryRow key={r.category.id} row={r} currency={currency} onOpen={() => setSheetId(r.category.id)} />)}
              </div>
            </Card>
          ))}

          {summary.uncategorized_count > 0 && (
            <Card title="Not in a category">
              <div className="list">
                <Link className="item clickable" href={`/finance/activity?category=uncategorized&month=${month7}`}>
                  <span className="icon-tile sm"><CircleHelp /></span>
                  <div className="item-main">
                    <div className="item-title">{summary.uncategorized_count} {summary.uncategorized_count === 1 ? "expense" : "expenses"}</div>
                    <div className="item-sub">Give them a category so they count</div>
                  </div>
                  <div className="item-end"><div className="v">{money(summary.uncategorized_cents, currency)}</div></div>
                </Link>
              </div>
            </Card>
          )}
        </div>

        <div className="dash-col">
          <Card title="Where it went">
            {summary.spent_cents > 0 && donut.length > 0
              ? <Donut data={donut} currency={currency} center={moneyTight(summary.spent_cents, currency)} centerLabel="spent" />
              : <p className="hint">No spending logged for this month yet.</p>}
          </Card>

          <Card title="Plan" action={<button type="button" className="btn btn-sm" style={{ minHeight: 36 }} onClick={() => setPlan({ initial: null })}>{summary.is_set_up ? "Edit plan" : "Set up"}</button>}>
            <div className="fin-kpis" style={{ margin: "-4px -18px 14px", borderTop: 0, borderBottom: "1px solid var(--line)" }}>
              <div><div className="k">Income</div><div className="v num">{money(summary.planned_income_cents, currency)}</div></div>
              <div><div className="k">Assigned</div><div className="v num">{money(summary.assigned_cents, currency)}</div></div>
              <div><div className="k">{ready < 0 ? "Over-assigned" : "To assign"}</div><div className={`v num ${ready < 0 ? "neg" : ""}`}>{money(Math.abs(ready), currency)}</div></div>
            </div>
            {ready > 0 && <p className="hint" style={{ margin: 0 }}>Give the rest a job in Edit plan.</p>}
            {!hasCats && <p className="hint" style={{ margin: 0 }}>Add a category to start planning.</p>}
          </Card>
        </div>
      </div>

      <p className="fin-foot">Savings categories count as money set aside, not spending. Transfers never count.</p>

      <BudgetPlanEditor open={plan !== null} month={month} budget={budget} initial={plan?.initial ?? null} onClose={() => setPlan(null)} />
      <BudgetCategorySheet open={activeRow !== null} row={activeRow} month={month} budget={budget} onClose={() => setSheetId(null)} />
    </>
  );
}

function paceNote(flex: FlexiblePace, currency: string): string {
  const p = flex.pace;
  // A few days of data make straight-line projections look alarming, so only project after a week.
  const elapsed = p.daysInMonth - p.daysLeft + 1;
  if (p.status === "over" && elapsed >= PACE_MIN_DAYS) return `Wants are running ahead: on pace for ${money(p.projectedCents, currency)} of ${money(flex.planned_cents, currency)}.`;
  if ((p.safePerDayCents ?? 0) > 0) return `About ${money(p.safePerDayCents ?? 0, currency)} a day left for wants.`;
  return "Your wants plan is used up for this month.";
}

function CategoryRow({ row, currency, onOpen }: { row: BudgetRow; currency: string; onOpen: () => void }) {
  const { category: c, limit_cents: limit, used_cents: used, remaining_cents: remaining } = row;
  const hasLimit = limit !== null;
  let sub: string;
  if (!hasLimit) sub = `${money(used, currency)} spent, no limit`;
  else if (limit === 0 && used === 0) sub = "Limit set to zero";
  else if (c.kind === "savings") sub = `${money(used, currency)} of ${money(limit, currency)} set aside`;
  else sub = `${money(used, currency)} of ${money(limit, currency)}`;

  let endText: string;
  let end: React.ReactNode;
  if (!hasLimit) { endText = "No limit"; end = <span className="faint">No limit</span>; }
  else if (row.status === "over" && remaining !== null) { endText = `${money(-remaining, currency)} over`; end = <span className="neg">{endText}</span>; }
  else if (row.status === "funded") { endText = "Funded"; end = <span className="pos">Funded</span>; }
  else { endText = `${money(remaining ?? 0, currency)} left`; end = endText; }

  return (
    <button type="button" className="item clickable" onClick={onOpen} aria-label={`${c.name}, ${endText}`}>
      <CategoryTile category={c} size="sm" />
      <div className="item-main">
        <div className="item-title">{c.name}{c.archived && <span className="faint"> (archived)</span>}</div>
        {hasLimit && limit > 0 && (
          <div className="fin-row-progress"><Progress size="sm" value={used} max={limit} tone={row.status === "over" ? "neg" : "pos"} /></div>
        )}
        <div className="item-sub">{sub}</div>
      </div>
      <div className="item-end"><div className="v">{end}</div></div>
    </button>
  );
}
