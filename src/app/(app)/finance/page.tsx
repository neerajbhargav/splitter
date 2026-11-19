"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, CalendarClock, Check, ChevronLeft, ChevronRight, CreditCard, Eye, FileUp, Plus, Repeat, Smartphone, Sparkles, Tag, Users, Wallet } from "lucide-react";
import { useMe } from "@/components/providers";
import { api, loadOverview } from "@/lib/data";
import { summarize, type PersonBalance } from "@/lib/overview";
import { Card, Progress } from "@/components/kit";
import { useFinance } from "@/components/finance/FinanceProvider";
import { DailyBars } from "@/components/finance/charts";
import { TransactionEditor } from "@/components/finance/TransactionEditor";
import { CategoryTile, DateTile, StatusChip, TxAmount, dayDiff, monthLong, relativeDay, shortDay } from "@/components/finance/kit";
import { askSuggestions } from "@/components/finance/ask-suggestions";
import { compareDebtPlans } from "@/lib/debt-planner";
import { PACE_MIN_DAYS, budgetInsights, currentBudgetMonth, summarizeBudget, type BudgetInsight } from "@/lib/budget-planner";
import { subscriptionEquivalentTotals } from "@/lib/subscription-planner";
import { dailySpending, evaluateHealth, healthScore, monthActivity, netWorth } from "@/lib/finance-insights";
import { forecastSubscriptionCharges, forecastTotalCents } from "@/lib/subscription-planner";
import { categoryLookup, debtsMissingTerms, isEmptyWorkspace, payoffDebts, sortTransactions } from "@/lib/finance-selectors";
import { money } from "@/lib/format";
import { paycheckTotals, paydaysFrom, scheduleFromSettings } from "@/lib/paycheck-planner";
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
    const schedule = scheduleFromSettings(bundle.settings);
    const nextPayday = schedule ? paydaysFrom(schedule, today, 1)[0] ?? null : null;
    const nextPaycheck = nextPayday ? bundle.paychecks.find((p) => p.pay_date === nextPayday) ?? null : null;
    const paycheckLeft = nextPaycheck ? paycheckTotals(nextPaycheck.amount_cents, nextPaycheck.allocations).left_cents : null;
    const subsCat = bundle.categories.find((c) => !c.archived && c.name.trim().toLowerCase() === "subscriptions") ?? null;
    const insights = budgetInsights(summary, {
      subscriptionsMonthlyCents: subsCat ? Number(subscriptionEquivalentTotals(bundle.subscriptions.filter((x) => x.category_id === subsCat.id)).monthly_cents) : 0,
      debtMinimumsCents: debts.reduce((a, d) => a + d.minimum_cents, 0), categories: bundle.categories, format: (c) => money(c, currency), paceBasis: "flexible",
    });
    const known_ids = new Set(bundle.categories.map((c) => c.id));
    const uncategorized = bundle.transactions.filter((t) => t.kind === "expense" && t.date.startsWith(month.slice(0, 7)) && (!t.category_id || !known_ids.has(t.category_id))).length;
    return { worth, summary, activity, topCategories, daily, rules, known, score: known >= 3 ? healthScore(rules) : null, charges, chargesTotal: Number(forecastTotalCents(charges)), debts, payoff, nextPayday, nextPaycheck, paycheckLeft, insights, uncategorized };
  }, [bundle, month, today, currency, cats]);

  if (isEmptyWorkspace(bundle)) return <Welcome />;

  const { worth, summary } = view;
  const recent = sortTransactions(bundle.transactions).slice(0, 6);
  const missingTerms = debtsMissingTerms(bundle.accounts);
  const spendLimit = summary.spending_limit_cents;
  const debtTotal = view.debts.reduce((a, d) => a + d.balance_cents, 0);
  const upcoming = [
    ...view.charges.map((c) => ({ key: `${c.subscription_id}-${c.date}`, date: c.date, title: c.name, sub: "Subscription", cents: c.amount_cents, income: false })),
    ...(view.nextPayday && dayDiff(today, view.nextPayday) <= 14
      ? [{ key: "pay", date: view.nextPayday, title: "Paycheck", sub: view.nextPaycheck ? "Planned" : "Not planned yet", cents: view.nextPaycheck?.amount_cents ?? bundle.settings?.paycheck_cents ?? 0, income: true }] : []),
  ].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <>
      <AskBar />

      <section className="card fin-snapshot" aria-label="Snapshot">
        <Link href="/finance/accounts" className="snap">
          <span className="k">Net worth</span>
          <span className={`v num ${worth.net < 0 ? "neg" : ""}`}>{bundle.accounts.length ? money(worth.net, currency) : "–"}</span>
          <span className="s">{bundle.accounts.length ? `${bundle.accounts.length} account${bundle.accounts.length === 1 ? "" : "s"}` : "Add your accounts"}</span>
        </Link>
        <Link href="/finance/budget" className="snap">
          <span className="k">{spendLimit > 0 ? "Left to spend" : "Spent this month"}</span>
          <span className={`v num ${spendLimit > 0 && summary.spent_cents > spendLimit ? "neg" : ""}`}>{money(spendLimit > 0 ? spendLimit - summary.spent_cents : summary.spent_cents, currency)}</span>
          <span className="s">{spendLimit > 0 ? `${money(summary.spent_cents, currency)} of ${money(spendLimit, currency)} spent` : "No plan for this month yet"}</span>
        </Link>
        <Link href="/finance/paycheck" className="snap">
          <span className="k">Next paycheck</span>
          <span className="v num">{view.nextPayday ? money(view.nextPaycheck?.amount_cents ?? bundle.settings?.paycheck_cents ?? 0, currency) : "–"}</span>
          <span className="s">{view.nextPayday ? `${relativeDay(view.nextPayday, today)} · ${shortDay(view.nextPayday)}` : "Set your pay schedule"}</span>
        </Link>
        <Link href="/finance/debt" className="snap">
          <span className="k">{view.debts.length ? "Debt-free by" : "Debt"}</span>
          <span className="v num">{view.debts.length ? (view.payoff ? monthLong(view.payoff) : money(debtTotal, currency)) : "None"}</span>
          <span className="s">{view.debts.length ? `${money(debtTotal, currency)} owed${view.payoff ? " · on minimums" : ""}` : missingTerms.length ? "Add APR and minimums" : "No cards or loans tracked"}</span>
        </Link>
      </section>

      <div className="dash-grid fin-dash">
        <div className="dash-col">
          <Card className="o-spending" title="Spending" description={`${monthLong(month)} · ${money(summary.spent_cents, currency)}${spendLimit > 0 ? ` of ${money(spendLimit, currency)} planned` : ""}`}
            action={<Link href="/finance/budget" className="btn btn-sm">Budget <ChevronRight /></Link>}>
            {spendLimit > 0 && (
              <div style={{ marginBottom: 14 }}>
                <Progress value={summary.spent_cents} max={spendLimit} tone={summary.spent_cents > spendLimit ? "neg" : "pos"} />
                <div className="fin-row-meta"><span>{Math.round((summary.spent_cents / spendLimit) * 100)}% of plan</span><span>{paceLine(summary, currency)}</span></div>
              </div>
            )}
            {view.topCategories.length ? (
              <div className="list">
                {view.topCategories.map(({ category, cents }) => (
                  <div className="item" key={category!.id}>
                    <CategoryTile category={category} size="sm" />
                    <div className="item-main"><div className="item-title">{category!.name}</div>
                      <div className="item-sub">{summary.spent_cents > 0 ? `${Math.round((cents / summary.spent_cents) * 100)}% of spending` : ""}</div></div>
                    <div className="item-end"><div className="v">{money(cents, currency)}</div></div>
                  </div>
                ))}
              </div>
            ) : <p className="hint">No spending logged this month yet.</p>}
            <div className="fin-subhead">Last 30 days</div>
            <DailyBars data={view.daily} currency={currency} />
          </Card>

          <Card className="o-recent" title="Recent activity" description={`${bundle.transactions.length} transaction${bundle.transactions.length === 1 ? "" : "s"} tracked`}
            action={<Link href="/finance/activity" className="btn btn-sm">All activity <ChevronRight /></Link>}>
            {recent.length ? (
              <div className="list">
                {recent.map((t) => {
                  const c = t.category_id ? cats.get(t.category_id) : null;
                  return (
                    <button type="button" className="item clickable" key={t.id} onClick={() => setEditing({ tx: t })}>
                      <CategoryTile category={c} income={t.kind === "income"} transfer={t.kind === "transfer"} />
                      <div className="item-main">
                        <div className="item-title">{t.description}</div>
                        <div className="item-sub">{relativeDay(t.date, today)} · {t.kind === "expense" ? c?.name ?? "Uncategorized" : t.kind === "income" ? "Income" : "Transfer"}{t.source === "applepay" ? " · Apple Pay" : ""}</div>
                      </div>
                      <div className="item-end"><div className="v"><TxAmount tx={t} currency={currency} /></div></div>
                    </button>
                  );
                })}
              </div>
            ) : <p className="hint">Nothing logged yet. Add a transaction or import a CSV from your bank.</p>}
            <button type="button" className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setEditing({ tx: null })}><Plus /> Add transaction</button>
          </Card>
        </div>

        <div className="dash-col">
          <InsightCard insights={view.insights} score={view.score} />
          <NeedsYou items={[
            ...(view.uncategorized ? [{ key: "uncat", icon: Tag, tone: "warn", title: `${view.uncategorized} expense${view.uncategorized === 1 ? " needs" : "s need"} a category`, sub: "So your budget and insights add up", href: `/finance/activity?category=uncategorized&month=${month.slice(0, 7)}` }] : []),
            ...(view.nextPayday && !view.nextPaycheck && dayDiff(today, view.nextPayday) <= 10 ? [{ key: "pay", icon: CalendarClock, tone: "info", title: `Plan your ${shortDay(view.nextPayday)} paycheck`, sub: `${relativeDay(view.nextPayday, today)}, before it lands`, href: "/finance/paycheck" }] : []),
            ...(!summary.is_set_up ? [{ key: "plan", icon: Wallet, tone: "info", title: `Plan ${monthLong(month).split(" ")[0]}`, sub: "Give every dollar a job with a 50/30/20 starter", href: "/finance/budget" }] : []),
            ...(missingTerms.length ? [{ key: "terms", icon: CreditCard, tone: "warn", title: `Add APR and minimum for ${missingTerms.length === 1 ? missingTerms[0].name : `${missingTerms.length} debts`}`, sub: "Needed for your payoff date", href: "/finance/accounts" }] : []),
            ...view.charges.filter((c) => dayDiff(today, c.date) <= 3).slice(0, 2).map((c) => ({ key: `sub-${c.subscription_id}`, icon: Repeat, tone: "info", title: `${c.name} renews ${relativeDay(c.date, today).toLowerCase()}`, sub: `${money(c.amount_cents, currency)} · cancel before then if you don't use it`, href: "/finance/subscriptions" })),
          ]} />

          <Card className="o-coming" title="Coming up" description={upcoming.length ? `${money(view.chargesTotal, currency)} due in the next 14 days` : "Next 14 days"}
            action={<Link href="/finance/subscriptions" className="btn btn-sm">Subscriptions <ChevronRight /></Link>}>
            {upcoming.length ? (
              <div className="list">
                {upcoming.slice(0, 6).map((u) => (
                  <div className="item" key={u.key}>
                    <DateTile date={u.date} />
                    <div className="item-main"><div className="item-title">{u.title}</div><div className="item-sub">{relativeDay(u.date, today)} · {u.sub}</div></div>
                    <div className="item-end"><div className={`v ${u.income ? "pos" : ""}`}>{u.income ? "+" : ""}{money(u.cents, currency)}</div></div>
                  </div>
                ))}
              </div>
            ) : <p className="hint">{bundle.subscriptions.length ? "Nothing renews in the next two weeks." : "Track subscriptions to see renewals before they hit."}</p>}
          </Card>

          <Card className="o-health" title="Financial health" description={view.score === null ? "Add your income to score your month" : `${view.known} of 6 checks scored`}
            action={<Link href="/finance/health" className="btn btn-sm">Details <ChevronRight /></Link>}>
            <div className="row-flex" style={{ gap: 16, alignItems: "center", marginBottom: 10 }}>
              <div className="fin-score" style={{ ["--p" as string]: view.score ?? 0, ["--c" as string]: scoreColor(view.score), width: 64, height: 64 }}>
                <div style={{ width: 52, height: 52 }}><b style={{ fontSize: 21 }}>{view.score ?? "–"}</b></div>
              </div>
              <div className="min0">
                <div style={{ fontWeight: 600 }}>{view.score === null ? "Add your numbers" : view.score >= 80 ? "Strong month" : view.score >= 50 ? "A few things to tighten" : "Needs attention"}</div>
                <div className="hint">{view.score === null ? "Income and accounts unlock the six checks." : "Out of 100"}</div>
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

          {!f.demo && <GroupsCard />}
          {!f.demo && <ApplePayCard logged={bundle.transactions.some((t) => t.source === "applepay")} />}
        </div>
      </div>

      <TransactionEditor open={editing !== null} tx={editing?.tx ?? null} onClose={() => setEditing(null)} />
    </>
  );
}

/**
 * The one accent card (from his bookmarked dashboards: one grain-gradient card among quiet hairline ones).
 * It cycles through the month's budget insights, most important first.
 */
function InsightCard({ insights, score }: { insights: BudgetInsight[]; score: number | null }) {
  const [i, setI] = useState(0);
  const list = insights.length ? insights : [{
    id: "steady", tone: "good" as const,
    title: score !== null && score >= 80 ? "A strong month so far" : "Nothing needs you right now",
    detail: "Your spending is inside your plan. New insights show up here as the month moves.",
  }];
  const cur = list[Math.min(i, list.length - 1)];
  return (
    <section className={`card fin-accent ${cur.tone}`} aria-live="polite">
      <div className="fin-accent-top">
        <span className="fin-accent-chip"><Sparkles /> {cur.tone === "bad" || cur.tone === "warn" ? "Worth a look" : "Insight"}</span>
        {list.length > 1 && (
          <span className="fin-accent-nav">
            <button type="button" aria-label="Previous insight" onClick={() => setI((i - 1 + list.length) % list.length)}><ChevronLeft /></button>
            <span className="num">{i + 1} of {list.length}</span>
            <button type="button" aria-label="Next insight" onClick={() => setI((i + 1) % list.length)}><ChevronRight /></button>
          </span>
        )}
      </div>
      <div className="fin-accent-title">{cur.title}</div>
      <p className="fin-accent-detail">{cur.detail}</p>
      <Link href="/finance/budget" className="fin-accent-cta">Open budget <ChevronRight /></Link>
    </section>
  );
}

type Need = { key: string; icon: typeof Tag; tone: string; title: string; sub: string; href: string };
/** Things only the user can do, each one tap away. Hidden when there are none. */
function NeedsYou({ items }: { items: Need[] }) {
  if (!items.length) return null;
  return (
    <Card className="o-needs" title="Needs you" description={`${items.length} thing${items.length === 1 ? "" : "s"} to do`}>
      <div className="list">
        {items.map(({ key, icon: Icon, tone, title, sub, href }) => (
          <Link key={key} href={href} className="item clickable fin-need">
            <span className={`icon-tile sm fin-need-${tone}`}><Icon /></span>
            <div className="item-main"><div className="item-title">{title}</div><div className="item-sub">{sub}</div></div>
            <ChevronRight className="fin-need-go" aria-hidden />
          </Link>
        ))}
      </div>
    </Card>
  );
}

/** Claude-style: ask a question about your own numbers, or start from a suggestion. Answers live on Ask. */
function AskBar() {
  const router = useRouter();
  const { currency } = useFinance();
  const [q, setQ] = useState("");
  const go = (text: string) => { const t = text.trim(); if (t) router.push(`/finance/ask?q=${encodeURIComponent(t)}`); };
  return (
    <section className="card fin-askbar">
      <form className="fin-askbar-form" onSubmit={(e) => { e.preventDefault(); go(q); }}>
        <Sparkles className="fin-askbar-icon" aria-hidden />
        <input className="fin-askbar-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about your money" aria-label="Ask about your money" />
        <button type="submit" className="btn btn-primary btn-icon" aria-label="Ask" disabled={!q.trim()}><ArrowUp /></button>
      </form>
      <div className="fin-askbar-chips">
        {askSuggestions(currency).map((s) => <button type="button" key={s} className="fin-chip" onClick={() => go(s)}>{s}</button>)}
      </div>
    </section>
  );
}

/** Points people at Apple Pay logging until they have it, then gets out of the way. */
function ApplePayCard({ logged }: { logged: boolean }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { let alive = true; api.tokenStatus().then((s) => alive && setOn(!!s.purchases)).catch(() => alive && setOn(null)); return () => { alive = false; }; }, []);
  if (on !== false || logged) return null;
  return (
    <Card title="Log Apple Pay automatically" description="Every tap lands here, already categorized"
      action={<Link href="/account#links" className="btn btn-sm">Set up <ChevronRight /></Link>}>
      <div className="row-flex" style={{ gap: 12, alignItems: "flex-start" }}>
        <span className="icon-tile sm"><Smartphone /></span>
        <p className="hint" style={{ margin: 0 }}>A one-time iPhone Shortcuts automation sends each Apple Pay purchase to SPLITTER. It picks the category you used last time at that merchant, and the card&apos;s account.</p>
      </div>
    </Card>
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
  const elapsed = pace.daysInMonth - pace.daysLeft + 1;
  if (pace.safePerDayCents !== null && (pace.status !== "over" || elapsed < PACE_MIN_DAYS)) return `${money(pace.safePerDayCents, currency)}/day for wants`;
  return `Wants on pace for ${money(pace.projectedCents, currency)}`;
}

function Welcome() {
  const { bundle, setDemo, settings } = useFinance();
  const steps = [
    { done: !!bundle.settings?.monthly_net_cents, title: "Add your income", body: "Gross and take-home pay power your budget and the six health checks.", action: <button type="button" className="btn btn-sm btn-primary" onClick={() => settings.show("profile")}>Add income</button> },
    { done: bundle.accounts.length > 0 || bundle.transactions.length > 0, title: "Bring in your money", body: "Add accounts by hand, import a CSV from any bank, or log every Apple Pay tap from your iPhone.", action: (
      <div className="row-flex wrap" style={{ gap: 6 }}>
        <Link href="/finance/accounts" className="btn btn-sm"><Wallet /> Add accounts</Link>
        <Link href="/finance/activity?import=1" className="btn btn-sm"><FileUp /> Import CSV</Link>
        <Link href="/account#links" className="btn btn-sm"><Smartphone /> Log Apple Pay</Link>
      </div>
    ) },
    { done: bundle.budgets.some((b) => b.limits.length > 0), title: "Plan this month", body: "Give every dollar of take-home a job with a 50/30/20 starter you can adjust.", action: <Link href="/finance/budget" className="btn btn-sm">Open budget</Link> },
  ];
  return (
    <section className="card">
      <div className="card-body" style={{ padding: "28px 22px" }}>
        <div className="serif" style={{ fontSize: 32, lineHeight: 1.1 }}>Set up your money.</div>
        <p className="muted" style={{ marginTop: 8, maxWidth: 560 }}>Budget, accounts, debt payoff, subscriptions and health checks in one private place. Free, and nothing is shared with your groups.</p>
        <div className="list fin-steps" style={{ marginTop: 18 }}>
          {steps.map((s, i) => (
            <div className="item" key={s.title} style={{ alignItems: "flex-start" }}>
              <span className={`fin-step-dot ${s.done ? "done" : i === steps.findIndex((x) => !x.done) ? "now" : ""}`}>{s.done ? <Check /> : i + 1}</span>
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

/** Money in your groups: who owes you, whom you owe, and your unpaid shares of upcoming bills. */
function GroupsCard() {
  const me = useMe();
  const [g, setG] = useState<{ totals: [string, { owe: number; owed: number }][]; people: PersonBalance[]; upcoming: [string, number][] } | null>(null);
  useEffect(() => {
    let alive = true;
    loadOverview(1).then((o) => {
      if (!alive) return;
      const s = summarize(o, me.id);
      const upcoming: Record<string, number> = {};
      for (const b of o.upcoming) {
        const mine = o.members.find((m) => m.group_id === b.group_id && m.user_id === me.id);
        const share = b.upcoming_bill_shares.find((x) => x.member_id === mine?.id);
        const left = share ? share.amount_cents - (share.paid_at ? share.paid_cents ?? share.amount_cents : 0) : 0;
        const cur = o.groups.find((x) => x.id === b.group_id)?.currency ?? "USD";
        if (left > 0) upcoming[cur] = (upcoming[cur] ?? 0) + left;
      }
      setG({ totals: Object.entries(s.totals), people: [...s.owesYou, ...s.youOwe].slice(0, 3), upcoming: Object.entries(upcoming) });
    }).catch(() => alive && setG({ totals: [], people: [], upcoming: [] }));
    return () => { alive = false; };
  }, [me.id]);
  if (!g) return null;
  return (
    <Card title="Groups" description="Shared costs with roommates, trips and friends" action={<Link href="/dashboard" className="btn btn-sm">Split <ChevronRight /></Link>}>
      {g.totals.length || g.upcoming.length ? (
        <div className="list">
          {g.totals.map(([cur, t]) => (
            <div className="item" key={cur}>
              <span className="icon-tile sm"><Users /></span>
              <div className="item-main"><div className="item-title">{t.owed >= t.owe ? "You're owed overall" : "You owe overall"}</div>
                <div className="item-sub">Owed to you {money(t.owed, cur)} · you owe {money(t.owe, cur)}</div></div>
              <div className="item-end"><div className={`v ${t.owed >= t.owe ? "pos" : "neg"}`}>{money(Math.abs(t.owed - t.owe), cur)}</div></div>
            </div>
          ))}
          {g.people.map((p) => (
            <div className="item" key={p.key} style={{ padding: "8px 0" }}>
              <div className="item-main"><div className="item-title" style={{ fontSize: 13.5 }}>{p.amount > 0 ? `${p.name} owes you` : `You owe ${p.name}`}</div></div>
              <div className="item-end"><div className={`v ${p.amount > 0 ? "pos" : "neg"}`}>{money(Math.abs(p.amount), p.currency)}</div></div>
            </div>
          ))}
          {g.upcoming.map(([cur, cents]) => (
            <div className="item" key={"up" + cur}>
              <span className="icon-tile sm"><CalendarClock /></span>
              <div className="item-main"><div className="item-title">Your unpaid upcoming bills</div>
                <div className="item-sub">Not in balances yet. Set it aside from your next paycheck.</div></div>
              <div className="item-end"><div className="v">{money(cents, cur)}</div></div>
            </div>
          ))}
        </div>
      ) : <p className="hint">All settled up in your groups.</p>}
    </Card>
  );
}
