"use client";
import "@/components/finance/styles/debt.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Pencil, Plus } from "lucide-react";
import { Card } from "@/components/kit";
import { Empty } from "@/components/ui";
import { DEMO_MESSAGE, useFinance } from "@/components/finance/FinanceProvider";
import { AccountEditor } from "@/components/finance/AccountEditor";
import { DebtPlanEditor, ordinal } from "@/components/finance/DebtPlanEditor";
import { DebtSchedule } from "@/components/finance/DebtSchedule";
import { PayoffChart } from "@/components/finance/charts";
import { AccountIcon, AmountChips, HeroText, MoneyInput, Pill, currencySymbol, errorText, monthLong, monthShort } from "@/components/finance/kit";
import { compareDebtPlans, type DebtPlan, type DebtPlanComparison, type DebtStrategy } from "@/lib/debt-planner";
import { debtsMissingTerms, payoffDebts, plannerInput } from "@/lib/finance-selectors";
import { centsToInput, money } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import { FINANCE_MAX_CENTS, isLiability, type DebtPlanInput, type DebtPlanSettings, type FinanceAccount, type FinanceAccountInput, type FinanceContext } from "@/lib/finance-types";

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

const STRATEGY_NAME: Record<DebtStrategy, string> = { avalanche: "Avalanche", snowball: "Snowball", custom: "Custom" };
const STRATEGY_RULE: Record<DebtStrategy, string> = { avalanche: "Highest APR first", snowball: "Smallest balance first", custom: "Your order and amounts" };

type Editing = { account: FinanceAccount | null; defaults?: Partial<FinanceAccountInput> };
type PlanFields = Pick<DebtPlanSettings, "strategy" | "extra_monthly_cents" | "rollover" | "priority" | "payments" | "extra_changes" | "lump_sums">;
type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

const EMPTY_PLAN: PlanFields = { strategy: "avalanche", extra_monthly_cents: 0, rollover: true, priority: [], payments: [], extra_changes: [], lump_sums: [] };

function toInput(p: PlanFields): DebtPlanInput {
  return {
    strategy: p.strategy, extra_monthly_cents: p.extra_monthly_cents, rollover: p.rollover, priority: p.priority,
    payments: p.payments, extra_changes: p.extra_changes,
    lump_sums: p.lump_sums.map((l) => ({ id: l.id.startsWith("local-") ? undefined : l.id, month: l.month, account_id: l.account_id, amount_cents: l.amount_cents, note: l.note })),
  };
}
let localSeq = 0;
function fromInput(i: DebtPlanInput): PlanFields {
  return { ...i, lump_sums: i.lump_sums.map((l) => ({ ...l, id: l.id ?? `local-${++localSeq}` })) };
}

function SaveNote({ state, demoNote }: { state: SaveState; demoNote: boolean }) {
  if (demoNote) return <div className="hint fin-plan-status">{DEMO_MESSAGE}</div>;
  if (state.kind === "saving") return <div className="hint fin-plan-status" aria-live="polite">Saving…</div>;
  if (state.kind === "saved") return <div className="hint fin-plan-status" aria-live="polite">Saved</div>;
  if (state.kind === "error") return <div className="hint neg fin-plan-status" role="alert">{state.message}</div>;
  return null;
}

type SummaryLine = { key: string; title: string; sub: string; value?: string; past?: boolean };

function planSummary(plan: PlanFields, debts: { id: string; name: string; minimum_cents: number }[], names: Map<string, string>, month: string, currency: string): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const order = plan.priority.filter((id) => debts.some((d) => d.id === id));
  for (const d of debts) {
    const pay = plan.payments.find((p) => p.account_id === d.id);
    if (!pay || (!pay.monthly_cents && !pay.due_day)) continue;
    const amount = pay.monthly_cents ? Math.max(pay.monthly_cents, d.minimum_cents) : d.minimum_cents;
    const rank = order.indexOf(d.id);
    const bits = [pay.monthly_cents ? "Your amount" : "Minimum"];
    if (pay.due_day) bits.push(`due the ${pay.due_day === 31 ? "last day" : ordinal(pay.due_day)}`);
    if (rank >= 0 && plan.strategy === "custom") bits.unshift(`#${rank + 1}`);
    lines.push({ key: `pay-${d.id}`, title: d.name, sub: bits.join(" · "), value: `${money(amount, currency)}/mo` });
  }
  for (const c of plan.extra_changes) {
    const now = c.month <= month;
    lines.push({ key: `chg-${c.month}`, title: now ? `Since ${monthShort(c.month)}` : `From ${monthShort(c.month)}`, sub: c.extra_monthly_cents ? "Extra each month" : "Stop paying extra", value: money(c.extra_monthly_cents, currency) });
  }
  for (const l of plan.lump_sums) {
    const past = l.month < month;
    const to = l.account_id ? names.get(l.account_id) ?? "a removed debt, so it follows your order" : "your payoff order";
    lines.push({ key: `lump-${l.id}`, title: l.note || "One-time payment", sub: past ? `${monthShort(l.month)} has passed, skipped` : `${monthShort(l.month)} to ${to}`, value: money(l.amount_cents, currency), past });
  }
  if (!plan.rollover) lines.push({ key: "roll", title: "No rollover", sub: "Paid-off payments stop instead of moving to the next debt" });
  return lines;
}

export default function DebtPage() {
  const { bundle, currency, today, api, ctx, demo } = useFinance();
  const saved = bundle.debt_plan;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  // Local copy of the plan so changes show instantly (and keep working in sample mode). Cleared when a newer saved plan arrives.
  const [local, setLocal] = useState<PlanFields | null>(null);
  const [extraText, setExtraText] = useState(() => (saved?.extra_monthly_cents ? centsToInput(saved.extra_monthly_cents) : ""));
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [demoNoted, setDemoNoted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ input: DebtPlanInput; context: FinanceContext } | null>(null);
  const savedStamp = useRef(saved?.updated_at);

  useEffect(() => {
    if (saved?.updated_at === savedStamp.current) return;
    savedStamp.current = saved?.updated_at;
    if (pending.current) return;
    setLocal(null);
    // Only rewrite the box when the saved amount really differs, so "50" never turns into "50.00" under your cursor.
    const savedExtra = saved?.extra_monthly_cents ?? 0;
    setExtraText((text) => ((parseMoney(text) ?? 0) === savedExtra ? text : savedExtra ? centsToInput(savedExtra) : ""));
  }, [saved?.updated_at, saved?.extra_monthly_cents]);

  const planFields: PlanFields = local ?? saved ?? EMPTY_PLAN;

  const parsed = parseMoney(extraText);
  const extraInvalid = extraText.trim() !== "" && (parsed === null || parsed < 0 || parsed > FINANCE_MAX_CENTS);
  const extra = Math.min(Math.max(parsed ?? 0, 0), FINANCE_MAX_CENTS);

  /** Saves now. Returns a message to show instead of "Saved", or null. */
  const persist = useCallback(async (input: DebtPlanInput, context: FinanceContext): Promise<string | null> => {
    if (demo) {
      setDemoNoted(true);
      return demoNoted ? null : DEMO_MESSAGE;
    }
    setSave({ kind: "saving" });
    try {
      await api.saveDebtPlan(input, context);
      setSave({ kind: "saved" });
      return null;
    } catch (e) {
      const message = errorText(e);
      setSave({ kind: "error", message });
      return message;
    }
  }, [api, demo, demoNoted]);

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const job = pending.current;
    pending.current = null;
    if (job) void persist(job.input, job.context);
  }, [persist]);

  // Save anything still waiting when you leave the page.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  /** Applies a change on screen right away and saves it (debounced for typing). */
  const update = useCallback((next: PlanFields, delay: number) => {
    setLocal(next);
    pending.current = { input: toInput(next), context: { ...ctx } };
    if (timer.current) clearTimeout(timer.current);
    if (delay <= 0) flush();
    else timer.current = setTimeout(flush, delay);
  }, [ctx, flush]);

  const onExtraChange = (text: string) => {
    setExtraText(text);
    const c = parseMoney(text);
    if (text.trim() !== "" && (c === null || c < 0 || c > FINANCE_MAX_CENTS)) return;
    update({ ...planFields, extra_monthly_cents: c ?? 0 }, 700);
  };

  const view = useMemo(() => {
    const liabilities = bundle.accounts.filter((a) => isLiability(a.type));
    const debts = payoffDebts(bundle.accounts);
    const missing = debtsMissingTerms(bundle.accounts);
    const month = today.slice(0, 7);
    let avalanche: DebtPlanComparison | null = null;
    let snowball: DebtPlanComparison | null = null;
    let custom: DebtPlanComparison | null = null;
    let failed = false;
    if (debts.length) {
      try {
        avalanche = compareDebtPlans(plannerInput(debts, planFields, "avalanche", month, extra));
        snowball = compareDebtPlans(plannerInput(debts, planFields, "snowball", month, extra));
        custom = compareDebtPlans(plannerInput(debts, planFields, "custom", month, extra));
      } catch { failed = true; avalanche = null; snowball = null; custom = null; }
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
    return { liabilities: sorted, debts, missing, avalanche, snowball, custom, failed, recommended, minimumsTotal, month };
  }, [bundle.accounts, extra, today, planFields]);

  const { liabilities, debts, missing, avalanche, snowball, custom, failed, recommended, minimumsTotal, month } = view;
  // A saved plan sets the strategy; before anything is saved, show the better of Avalanche and Snowball.
  const effective: DebtStrategy = local || saved ? planFields.strategy : recommended;
  const comparisonFor = (s: DebtStrategy) => (s === "avalanche" ? avalanche : s === "snowball" ? snowball : custom);
  const chosen = comparisonFor(effective);
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
    <>
      <AccountEditor open={editing !== null} account={editing?.account ?? null} defaults={editing?.defaults} onClose={() => setEditing(null)} />
      <DebtPlanEditor open={planOpen} plan={planFields} debts={view.debts} strategy={effective} extraCents={extra} onClose={() => setPlanOpen(false)}
        onSave={async (input, context) => {
          if (timer.current) { clearTimeout(timer.current); timer.current = null; }
          pending.current = null;
          setLocal(fromInput(input));
          if (demo) { setDemoNoted(true); return DEMO_MESSAGE; }
          return persist(input, context);
        }} />
    </>
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
      const ms = chosen.months_saved ?? 0;
      if (chosen.interest_saved_cents !== null && (chosen.interest_saved_cents > 0n || ms > 0)) {
        const savedText = bigMoney(chosen.interest_saved_cents, currency);
        note = ms > 0 ? `${ms === 1 ? "1 month" : `${ms} months`} sooner and ${savedText} less interest than paying minimums only.` : `${savedText} less interest than paying minimums only.`;
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

  const options: DebtStrategy[] = ["avalanche", "snowball", "custom"];
  const optionBadge = (s: DebtStrategy): string | null => {
    if (s === "custom") {
      const mine = custom?.plan;
      const presets = [avalanche?.plan, snowball?.plan].filter((p): p is DebtPlan => !!p?.is_finite);
      if (!mine?.is_finite || !presets.length) return null;
      const best = presets.reduce((a, b) => (b.estimated_interest_cents < a.estimated_interest_cents ? b : a));
      const diff = mine.estimated_interest_cents - best.estimated_interest_cents;
      if (diff > 0n) return `+${bigMoney(diff, currency)} interest`;
      if (diff < 0n) return `Saves ${bigMoney(-diff, currency)}`;
      if (mine.months === best.months) return "Same result";
      const m = (best.months ?? 0) - (mine.months ?? 0);
      return m > 0 ? `${m} mo sooner` : `${-m} mo later`;
    }
    if (s !== recommended) return null;
    const mine = (s === "avalanche" ? avalanche : snowball)?.plan;
    const other = (s === "avalanche" ? snowball : avalanche)?.plan;
    if (mine?.is_finite && other?.is_finite) {
      const diff = other.estimated_interest_cents - mine.estimated_interest_cents;
      if (diff > 0n) return `Saves ${bigMoney(diff, currency)}`;
      if (diff === 0n && mine.months === other.months) return "Same result";
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
                  <div className="fin-compare three" role="group" aria-label="Payoff strategy">
                    {options.map((s) => {
                      const p = comparisonFor(s)?.plan;
                      const badge = optionBadge(s);
                      return (
                        <button key={s} type="button" className={`fin-option ${effective === s ? "on" : ""}`} aria-pressed={effective === s} onClick={() => { if (effective !== s || !(local || saved)) update({ ...planFields, extra_monthly_cents: extra, strategy: s }, 0); }} style={{ minHeight: 36 }}>
                          <div className="t">{STRATEGY_NAME[s]}{badge && <span className="badge gold">{badge}</span>}</div>
                          <div className="d">{p?.is_finite && p.payoff_month ? monthShort(p.payoff_month) : "No end date"}</div>
                          <div className="s">{p?.is_finite ? `${STRATEGY_RULE[s]} · ${bigMoney(p.estimated_interest_cents, currency)} interest` : STRATEGY_RULE[s]}</div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="stack-sm">
                    <label className="label" htmlFor="fin-debt-extra">Extra each month</label>
                    <MoneyInput id="fin-debt-extra" value={extraText} onChange={onExtraChange} currency={currency} />
                    <AmountChips values={presets(minimumsTotal)} currency={currency} current={extra} onPick={(c) => { setExtraText(c ? centsToInput(c) : ""); update({ ...planFields, extra_monthly_cents: c }, 0); }} />
                    {extraInvalid
                      ? <div className="hint neg">Enter an amount like 50 or 125.50.</div>
                      : <div className="hint">On top of {money(minimumsTotal, currency)} in minimums{effective === "custom" ? " and your own amounts" : ""}.</div>}
                  </div>
                  <SaveNote state={save} demoNote={demo && demoNoted} />
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
          {debts.length > 0 && (() => {
            const names = new Map(liabilities.map((a) => [a.id, a.name]));
            const lines = planSummary(planFields, debts, names, month, currency);
            return (
              <Card title="Your payment plan" description={effective === "custom" ? "In use now" : `Using ${STRATEGY_NAME[effective]}. Changes and one-time payments still apply.`}
                action={<button type="button" className="btn btn-sm" style={{ minHeight: 36 }} onClick={() => setPlanOpen(true)}><Pencil /> Edit plan</button>}>
                {lines.length ? (
                  <div className="list">
                    {lines.map((l) => (
                      <div key={l.key} className={`item ${l.past ? "fin-plan-past" : ""}`}>
                        <div className="item-main">
                          <div className="item-title">{l.title}</div>
                          <div className="item-sub">{l.sub}</div>
                        </div>
                        {l.value && <div className="item-end"><div className="v">{l.value}</div></div>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="hint">Set your own payment for each debt, the order to pay them in, due days, and one-time payments like a tax refund.</p>
                )}
              </Card>
            );
          })()}

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
