"use client";
import "@/components/finance/styles/paycheck.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock, CircleAlert, CircleCheck, Landmark, PiggyBank, Plus, Receipt, Settings2, Shapes, ShoppingCart, Sparkles, Trash2, type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/kit";
import { Empty, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { DEMO_MESSAGE, STALE_DRAFT, sameContext, useFinance } from "@/components/finance/FinanceProvider";
import { Hero, Pill, errorText, relativeDay, shortDay } from "@/components/finance/kit";
import { PayScheduleEditor } from "@/components/finance/PayScheduleEditor";
import { PaycheckDetailsEditor, PaycheckLineEditor, type LineDraft } from "@/components/finance/PaycheckLineEditor";
import { simulateDebtPlan } from "@/lib/debt-planner";
import { dueDayFor, payoffDebts, planPaymentLookup, plannerInput } from "@/lib/finance-selectors";
import { money } from "@/lib/format";
import {
  ALLOCATION_KIND_LABEL, ALLOCATION_ORDER, PAY_CYCLE_LABEL, mergeSuggestions, payPeriod, paycheckTotals, paydaysFrom, scheduleFromSettings,
  suggestAllocations, type SuggestedLine,
} from "@/lib/paycheck-planner";
import type { AllocationKind, FinanceContext, Paycheck, PaycheckAllocation, PaycheckInput } from "@/lib/finance-types";

const KIND_ICON: Record<AllocationKind, LucideIcon> = { bill: Receipt, debt: Landmark, spending: ShoppingCart, savings: PiggyBank, other: Shapes };
const UPCOMING = 4;
const HISTORY = 5;

function parseDay(iso: string) {
  return new Date(`${iso}T00:00:00`);
}
function longDay(iso: string, today: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "short", day: "numeric" };
  if (iso.slice(0, 4) !== today.slice(0, 4)) opts.year = "numeric";
  return parseDay(iso).toLocaleDateString("en-US", opts);
}
function weekdayShort(iso: string): string {
  return parseDay(iso).toLocaleDateString("en-US", { weekday: "short" });
}
const newId = () => crypto.randomUUID();
const keyOf = (a: Pick<PaycheckAllocation, "kind" | "ref_id" | "label">) => `${a.kind}:${a.ref_id ?? a.label.toLowerCase()}`;

type Working = { id?: string; pay_date: string; amount_cents: number; allocations: PaycheckAllocation[]; note: string; received: boolean };

export default function PaycheckPage() {
  const { bundle, currency, today, ctx, api, reload, demo } = useFinance();
  const toast = useToast();
  const settings = bundle.settings;
  const schedule = useMemo(() => scheduleFromSettings(settings), [settings]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, Working>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lineEditing, setLineEditing] = useState<LineDraft | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Writes are bound to the account + currency on screen when the page opened.
  const captured = useRef<FinanceContext>({ ...ctx });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const createdIds = useRef<Record<string, string>>({});

  const saved = useMemo(() => new Map(bundle.paychecks.map((p) => [p.pay_date, p])), [bundle.paychecks]);
  const upcoming = useMemo(() => (schedule ? paydaysFrom(schedule, today, UPCOMING) : []), [schedule, today]);
  const strip = useMemo(() => {
    const dates = new Set(upcoming);
    for (const p of bundle.paychecks) if (p.pay_date >= today) dates.add(p.pay_date);
    return [...dates].sort().slice(0, UPCOMING + 2);
  }, [upcoming, bundle.paychecks, today]);
  const history = useMemo(() => bundle.paychecks.filter((p) => p.pay_date < today).sort((a, b) => b.pay_date.localeCompare(a.pay_date)).slice(0, HISTORY), [bundle.paychecks, today]);

  const selected = picked ?? strip[0] ?? null;
  useEffect(() => { setConfirmDelete(false); setError(null); }, [selected]);

  const fromSaved = (p: Paycheck): Working => ({ id: p.id, pay_date: p.pay_date, amount_cents: p.amount_cents, allocations: p.allocations, note: p.note, received: p.received });
  const working: Working | null = selected
    ? optimistic[selected] ?? (saved.get(selected) ? fromSaved(saved.get(selected)!) : { pay_date: selected, amount_cents: settings?.paycheck_cents ?? 0, allocations: [], note: "", received: false })
    : null;
  const isSaved = !!working && (!!working.id || !!createdIds.current[working.pay_date]);

  /* ---------- suggestions from the budget, bills and debt plan ---------- */
  const period = useMemo(() => (selected ? payPeriod(selected, schedule) : null), [selected, schedule]);
  const suggestions = useMemo<SuggestedLine[]>(() => {
    if (!selected || !period) return [];
    const debts = payoffDebts(bundle.accounts);
    let lookup: (id: string, month: string) => number = () => 0;
    try {
      const plan = simulateDebtPlan(plannerInput(debts, bundle.debt_plan, bundle.debt_plan?.strategy ?? "avalanche", today.slice(0, 7)));
      lookup = planPaymentLookup(plan);
    } catch {
      const minimums = new Map(debts.map((d) => [d.id, d.minimum_cents]));
      lookup = (id) => minimums.get(id) ?? 0;
    }
    const monthStart = `${selected.slice(0, 7)}-01`;
    const budget = bundle.budgets.find((b) => b.month === monthStart)
      ?? [...bundle.budgets].filter((b) => b.month < monthStart).sort((a, b) => b.month.localeCompare(a.month))[0];
    try {
      return suggestAllocations({
        period,
        cycle: schedule?.cycle ?? "biweekly",
        subscriptions: bundle.subscriptions,
        debts: debts.map((d) => ({ id: d.id, name: d.name, due_day: dueDayFor(bundle.debt_plan, d.id) })),
        debtPaymentFor: lookup,
        categories: bundle.categories,
        limits: budget?.limits ?? [],
      });
    } catch {
      return [];
    }
  }, [selected, period, schedule, bundle.accounts, bundle.debt_plan, bundle.budgets, bundle.subscriptions, bundle.categories, today]);
  const hints = useMemo(() => new Map(suggestions.map((s) => [keyOf(s), s])), [suggestions]);

  /* ---------- saving: whole paycheck, queued, optimistic with rollback ---------- */
  const persist = useCallback((next: Working, success?: string): Promise<boolean> => {
    if (!sameContext(captured.current, ctx)) { setError(STALE_DRAFT); return Promise.resolve(false); }
    if (next.amount_cents <= 0) {
      setError("Add this paycheck's take-home first so the plan has something to divide.");
      setDetailsOpen(true);
      return Promise.resolve(false);
    }
    const date = next.pay_date;
    setOptimistic((o) => ({ ...o, [date]: next }));
    setError(null);
    const run = queue.current.then(async () => {
      setSaving(true);
      try {
        const id = next.id ?? createdIds.current[date];
        const input: PaycheckInput = { id, pay_date: date, amount_cents: next.amount_cents, allocations: next.allocations, note: next.note, received: next.received };
        const newIdSaved = await api.savePaycheck(input, captured.current);
        if (!id) createdIds.current[date] = newIdSaved;
        await reload();
        setOptimistic((o) => {
          if (o[date] !== next) return o;
          const { [date]: _done, ...rest } = o;
          return rest;
        });
        if (success) toast.ok(success);
        return true;
      } catch (e) {
        setOptimistic((o) => {
          if (o[date] !== next) return o;
          const { [date]: _gone, ...rest } = o;
          return rest;
        });
        setError(demo ? `${DEMO_MESSAGE} You can still look through the suggestions.` : errorText(e));
        return false;
      } finally {
        setSaving(false);
      }
    });
    queue.current = run.catch(() => undefined);
    return run;
  }, [api, ctx, demo, reload, toast]);

  const update = (patch: Partial<Working>, success?: string) => (working ? persist({ ...working, ...patch }, success) : Promise.resolve(false));

  async function saveLine(line: LineDraft): Promise<boolean> {
    if (!working) return false;
    const full: PaycheckAllocation = { ...line, id: line.id ?? newId() };
    const allocations = line.id ? working.allocations.map((a) => (a.id === line.id ? full : a)) : [...working.allocations, full];
    return update({ allocations });
  }
  async function deleteLine(id: string): Promise<boolean> {
    if (!working) return false;
    return update({ allocations: working.allocations.filter((a) => a.id !== id) });
  }
  function toggleDone(id: string) {
    if (!working) return;
    void update({ allocations: working.allocations.map((a) => (a.id === id ? { ...a, done: !a.done } : a)) });
  }

  async function removePaycheck() {
    if (!working) return;
    const id = working.id ?? createdIds.current[working.pay_date];
    if (!id) return;
    if (!sameContext(captured.current, ctx)) return setError(STALE_DRAFT);
    setSaving(true);
    try {
      await queue.current;
      await api.deletePaycheck(id, captured.current);
      delete createdIds.current[working.pay_date];
      setOptimistic((o) => { const { [working.pay_date]: _x, ...rest } = o; return rest; });
      await reload();
      toast.ok("Paycheck plan deleted");
    } catch (e) {
      setError(demo ? DEMO_MESSAGE : errorText(e));
    } finally {
      setSaving(false);
      setConfirmDelete(false);
    }
  }

  /* ---------- no schedule yet ---------- */
  if (!schedule && bundle.paychecks.length === 0) {
    return (
      <>
        <Card>
          <Empty title="Plan your next paycheck"
            action={<button type="button" className="btn btn-primary" onClick={() => setScheduleOpen(true)}><CalendarClock /> Set up pay schedule</button>}>
            Tell us when you get paid and roughly how much. We&apos;ll line up the bills, debt payments and budget that each paycheck needs to cover, and show what&apos;s left to give a job.
          </Empty>
        </Card>
        <PayScheduleEditor open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      </>
    );
  }

  if (!working || !period) {
    return (
      <>
        <Card>
          <Empty title="No paycheck to plan" action={<button type="button" className="btn btn-primary" onClick={() => setScheduleOpen(true)}><CalendarClock /> Set up pay schedule</button>}>
            Set up your pay schedule to see upcoming paydays.
          </Empty>
        </Card>
        <PayScheduleEditor open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      </>
    );
  }

  const totals = paycheckTotals(working.amount_cents, working.allocations);
  const previewTotal = suggestions.reduce((s, l) => s + l.amount_cents, 0);
  const shownLeft = isSaved || working.allocations.length ? totals.left_cents : working.amount_cents;
  const merged = isSaved ? mergeSuggestions(working.allocations, suggestions, newId) : working.allocations;
  const missing = merged.length - working.allocations.length;
  const isNext = working.pay_date === upcoming[0];
  const past = working.pay_date < today;
  const rel = relativeDay(working.pay_date, today);

  const savingsCat = bundle.categories.find((c) => c.kind === "savings" && !c.archived && /saving/i.test(c.name)) ?? bundle.categories.find((c) => c.kind === "savings" && !c.archived);
  const debts = payoffDebts(bundle.accounts);
  const priority = bundle.debt_plan?.strategy === "custom" ? bundle.debt_plan.priority : [];
  const topDebt = debts.find((d) => d.id === priority.find((id) => debts.some((x) => x.id === id)))
    ?? [...debts].sort((a, b) => b.apr_bps - a.apr_bps || a.balance_cents - b.balance_cents)[0];

  function putRest(kind: "savings" | "debt") {
    if (!working || totals.left_cents <= 0) return;
    const target = kind === "savings" ? savingsCat ? { id: savingsCat.id, name: savingsCat.name } : null : topDebt ? { id: topDebt.id, name: topDebt.name } : null;
    const existing = target ? working.allocations.find((a) => a.kind === kind && a.ref_id === target.id) : undefined;
    const allocations = existing
      ? working.allocations.map((a) => (a.id === existing.id ? { ...a, amount_cents: a.amount_cents + totals.left_cents } : a))
      : [...working.allocations, { id: newId(), label: target?.name ?? (kind === "savings" ? "Savings" : "Extra debt payment"), kind, ref_id: target?.id ?? null, amount_cents: totals.left_cents, done: false }];
    void update({ allocations }, `${money(totals.left_cents, currency)} put toward ${target?.name ?? (kind === "savings" ? "savings" : "debt")}`);
  }

  const groups = ALLOCATION_ORDER.map((kind) => ({ kind, lines: working.allocations.filter((a) => a.kind === kind) })).filter((g) => g.lines.length);
  const heroLabel = `${isNext ? "Next paycheck" : past ? "Paycheck" : "Upcoming paycheck"} · ${longDay(working.pay_date, today)}${rel !== shortDay(working.pay_date) ? ` · ${rel.toLowerCase()}` : ""}`;
  const covers = `Covers ${shortDay(period.start)} to ${shortDay(period.last)}.`;
  const heroNote = shownLeft < 0
    ? `${covers} You've planned ${money(-shownLeft, currency)} more than this paycheck, so trim a line or move it to the next one.`
    : shownLeft === 0 && working.allocations.length
      ? `${covers} Every dollar has a job.`
      : covers;

  return (
    <>
      <Hero label={heroLabel} cents={working.amount_cents} currency={currency}
        note={heroNote}
        actions={(
          <>
            <button type="button" className="btn btn-sm" onClick={() => setDetailsOpen(true)}>Edit amount</button>
            {isSaved && (
              <button type="button" className={`btn btn-sm ${working.received ? "btn-primary" : ""}`} aria-pressed={working.received}
                onClick={() => void update({ received: !working.received }, working.received ? "Marked as not received" : "Marked as received")}>
                <CircleCheck /> {working.received ? "Received" : "Mark received"}
              </button>
            )}
          </>
        )}>
        <Pill label="Assigned" value={money(isSaved || working.allocations.length ? totals.assigned_cents : 0, currency)} />
        {shownLeft < 0
          ? <Pill color="var(--neg)" label="Over by" value={<span className="neg">{money(-shownLeft, currency)}</span>} />
          : <Pill color="var(--pos)" label="Left" value={<span className={shownLeft > 0 ? "pos" : ""}>{money(shownLeft, currency)}</span>} />}
      </Hero>

      {error && (
        <div className={`banner ${demo ? "" : "neg"}`} role="alert">
          <CircleAlert /><span className="min0">{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <nav className="fin-pay-strip" aria-label="Paydays">
        {strip.map((d) => {
          const o = optimistic[d];
          const p = o && (o.id || o.allocations.length) ? o : saved.get(d);
          const left = p ? paycheckTotals(p.amount_cents, p.allocations).left_cents : null;
          return (
            <button key={d} type="button" className={`fin-pay-day ${d === working.pay_date ? "on" : ""}`} aria-pressed={d === working.pay_date} onClick={() => setPicked(d)}>
              <span className="w">{weekdayShort(d)}</span>
              <span className="d">{shortDay(d)}</span>
              <span className={`s ${left !== null && left < 0 ? "neg" : ""}`}>{p ? (left === 0 ? "All assigned" : left! < 0 ? "Over" : "Planned") : "Not planned"}</span>
            </button>
          );
        })}
        {!strip.includes(working.pay_date) && (
          <button type="button" className="fin-pay-day on" aria-pressed>
            <span className="w">{weekdayShort(working.pay_date)}</span>
            <span className="d">{shortDay(working.pay_date)}</span>
            <span className="s">Past</span>
          </button>
        )}
      </nav>

      <div className="dash-grid">
        <div className="dash-col">
          {!isSaved && working.allocations.length === 0 ? (
            <Card title="Suggested from your plan" description={suggestions.length ? `${money(previewTotal, currency)} of ${money(working.amount_cents, currency)} for ${shortDay(period.start)} to ${shortDay(period.last)}` : undefined}
              action={saving ? <Spinner /> : undefined}>
              {suggestions.length ? (
                <div className="stack">
                  <div className="list">
                    {suggestions.map((s) => {
                      const Icon = KIND_ICON[s.kind];
                      return (
                        <div key={keyOf(s)} className="item">
                          <span className="icon-tile sm"><Icon /></span>
                          <div className="item-main">
                            <div className="item-title">{s.label}</div>
                            <div className="item-sub">{s.due_date ? `Due ${shortDay(s.due_date)} · ` : ""}{s.reason}</div>
                          </div>
                          <div className="item-end"><div className="v num">{money(s.amount_cents, currency)}</div></div>
                        </div>
                      );
                    })}
                  </div>
                  {previewTotal > working.amount_cents && working.amount_cents > 0 && (
                    <p className="hint neg">That's {money(previewTotal - working.amount_cents, currency)} more than this paycheck. You can trim lines after you add them.</p>
                  )}
                  <div className="fin-pay-actions">
                    <button type="button" className="btn btn-primary" disabled={saving}
                      onClick={() => void persist({ ...working, allocations: suggestions.map((s) => ({ id: newId(), label: s.label, kind: s.kind, ref_id: s.ref_id, amount_cents: s.amount_cents, done: false })) }, "Paycheck planned")}>
                      <Sparkles /> Use these
                    </button>
                    <button type="button" className="btn" onClick={() => { setLineEditing(null); setLineOpen(true); }}><Plus /> Start from scratch</button>
                  </div>
                </div>
              ) : (
                <div className="stack">
                  <p className="hint">Nothing in your budget, bills or debt plan lands on this paycheck yet. Add lines yourself, or set up a budget and your debts for suggestions.</p>
                  <div className="fin-pay-actions">
                    <button type="button" className="btn btn-primary" onClick={() => { setLineEditing(null); setLineOpen(true); }}><Plus /> Add line</button>
                  </div>
                </div>
              )}
            </Card>
          ) : (
            <Card title="Where it goes" description={`${working.allocations.length} ${working.allocations.length === 1 ? "line" : "lines"}${totals.done_cents ? ` · ${money(totals.done_cents, currency)} done` : ""}`}
              action={saving ? <Spinner /> : <button type="button" className="btn btn-sm" onClick={() => { setLineEditing(null); setLineOpen(true); }}><Plus /> Add line</button>}>
              <div className="stack">
                {groups.length === 0 && <p className="hint">No lines yet. Add one, or pull in what your plan suggests.</p>}
                {groups.map((g) => {
                  const Icon = KIND_ICON[g.kind];
                  return (
                    <section key={g.kind} className="fin-pay-group" aria-label={ALLOCATION_KIND_LABEL[g.kind]}>
                      <div className="fin-pay-group-head">
                        <span>{ALLOCATION_KIND_LABEL[g.kind]}</span>
                        <span className="num">{money(totals.by_kind[g.kind], currency)}</span>
                      </div>
                      <div className="list">
                        {g.lines.map((a) => {
                          const hint = hints.get(keyOf(a));
                          return (
                            <div key={a.id} className={`item fin-pay-line ${a.done ? "done" : ""}`}>
                              <label className="fin-pay-check" title={a.done ? "Mark as not done" : "Mark as done"}>
                                <input type="checkbox" checked={a.done} onChange={() => toggleDone(a.id)} aria-label={`${a.label} done`} />
                              </label>
                              <button type="button" className="fin-pay-line-main" onClick={() => { setLineEditing(a); setLineOpen(true); }} aria-label={`Edit ${a.label}`}>
                                <span className="icon-tile sm"><Icon /></span>
                                <span className="item-main">
                                  <span className="item-title">{a.label}</span>
                                  <span className="item-sub">{hint?.due_date ? `Due ${shortDay(hint.due_date)}` : hint ? hint.reason : a.done ? "Done" : ALLOCATION_KIND_LABEL[a.kind]}</span>
                                </span>
                                <span className="item-end"><span className="v num">{money(a.amount_cents, currency)}</span></span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
                <div className="fin-pay-actions">
                  {totals.left_cents > 0 && (
                    <button type="button" className="btn btn-sm" disabled={saving} onClick={() => putRest("savings")}><PiggyBank /> Put the rest in savings</button>
                  )}
                  {totals.left_cents > 0 && topDebt && (
                    <button type="button" className="btn btn-sm" disabled={saving} onClick={() => putRest("debt")}><Landmark /> Put the rest toward {topDebt.name}</button>
                  )}
                  {isSaved && suggestions.length > 0 && (
                    <button type="button" className="btn btn-sm" disabled={saving || missing === 0}
                      onClick={() => void update({ allocations: merged }, `Added ${missing} from your plan`)}>
                      <Sparkles /> {missing ? `Add ${missing} missing from plan` : "Everything from your plan is here"}
                    </button>
                  )}
                </div>
              </div>
            </Card>
          )}
        </div>

        <div className="dash-col">
          <Card title="Pay schedule" action={<button type="button" className="btn btn-sm" onClick={() => setScheduleOpen(true)}><Settings2 /> {schedule ? "Edit" : "Set up"}</button>}>
            {schedule ? (
              <div className="list">
                <div className="item">
                  <span className="icon-tile sm"><CalendarClock /></span>
                  <div className="item-main">
                    <div className="item-title">{PAY_CYCLE_LABEL[schedule.cycle]}</div>
                    <div className="item-sub">Next payday {upcoming[0] ? longDay(upcoming[0], today) : "not found"}</div>
                  </div>
                  <div className="item-end"><div className="v num">{settings?.paycheck_cents ? money(settings.paycheck_cents, currency) : "Add amount"}</div><div className="k">usual</div></div>
                </div>
              </div>
            ) : <p className="hint">No schedule right now, so upcoming paydays aren&apos;t shown. Your saved plans are below.</p>}
          </Card>

          {working.note && (
            <Card title="Note"><p className="fin-pay-note">{working.note}</p></Card>
          )}

          {history.length > 0 && (
            <Card title="History" description="Your most recent planned paychecks">
              <div className="list">
                {history.map((p) => {
                  const t = paycheckTotals(p.amount_cents, p.allocations);
                  return (
                    <button key={p.id} type="button" className={`item clickable ${p.pay_date === working.pay_date ? "on" : ""}`} onClick={() => setPicked(p.pay_date)}>
                      <span className={`icon-tile sm ${p.received ? "fin-in" : ""}`}>{p.received ? <CircleCheck /> : <CalendarClock />}</span>
                      <div className="item-main">
                        <div className="item-title">{longDay(p.pay_date, today)}</div>
                        <div className="item-sub">{p.received ? "Received" : "Not marked received"}{t.left_cents > 0 ? ` · ${money(t.left_cents, currency)} unassigned` : t.left_cents < 0 ? ` · over by ${money(-t.left_cents, currency)}` : ""}</div>
                      </div>
                      <div className="item-end"><div className="v num">{money(p.amount_cents, currency)}</div></div>
                    </button>
                  );
                })}
              </div>
            </Card>
          )}

          {isSaved && (
            <div className="fin-pay-delete">
              {confirmDelete ? (
                <div className="banner" role="alert">
                  <span className="min0">Delete the plan for {shortDay(working.pay_date)}? The payday stays on your schedule.</span>
                  <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(false)} disabled={saving}>Keep</button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => void removePaycheck()} disabled={saving}>Delete</button>
                </div>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete this plan</button>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="fin-foot">Bills and debt payments due before your next payday come out of this paycheck. Budget categories get this paycheck&apos;s share of the month.</p>

      <PayScheduleEditor open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      <PaycheckLineEditor open={lineOpen} line={lineEditing} onClose={() => setLineOpen(false)} onSave={saveLine}
        onDelete={lineEditing?.id ? () => deleteLine(lineEditing.id!) : undefined} />
      <PaycheckDetailsEditor open={detailsOpen} amountCents={working.amount_cents} note={working.note} title={`Paycheck on ${shortDay(working.pay_date)}`}
        onClose={() => setDetailsOpen(false)}
        onSave={(amount_cents, note) => (isSaved ? update({ amount_cents, note }, "Paycheck updated") : (persistDetails(amount_cents, note)))} />
    </>
  );

  /** Unsaved paycheck: remember the amount locally until a line is added, so nothing empty gets saved. */
  function persistDetails(amount_cents: number, note: string): Promise<boolean> {
    if (!working) return Promise.resolve(false);
    if (working.allocations.length === 0) {
      setOptimistic((o) => ({ ...o, [working.pay_date]: { ...working, amount_cents, note } }));
      setError(null);
      return Promise.resolve(true);
    }
    return persist({ ...working, amount_cents, note }, "Paycheck updated");
  }
}
