"use client";
import "@/components/finance/styles/subscriptions.css";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Plus, Repeat, Search, X } from "lucide-react";
import { Card } from "@/components/kit";
import { Empty } from "@/components/ui";
import { useToast } from "@/components/providers";
import { useFinance } from "@/components/finance/FinanceProvider";
import { SubscriptionEditor, type SubscriptionPrefill } from "@/components/finance/SubscriptionEditor";
import { SubscriptionSheet } from "@/components/finance/SubscriptionSheet";
import { CategoryTile, DateTile, Hero, Pill, relativeDay, shortDay } from "@/components/finance/kit";
import { detectRecurring, type RecurringSuggestion } from "@/lib/finance-import";
import { categoryLookup } from "@/lib/finance-selectors";
import { money } from "@/lib/format";
import type { Subscription, SubscriptionCycle } from "@/lib/finance-types";
import { forecastSubscriptionCharges, forecastTotalCents, nextRenewalDate, subscriptionEquivalent, subscriptionEquivalentTotals } from "@/lib/subscription-planner";

const CYCLE_WORD: Record<SubscriptionCycle, string> = { weekly: "weekly", monthly: "monthly", quarterly: "every 3 months", yearly: "yearly" };
type Filter = "active" | "paused" | "canceled" | "all";

// Renewals keep the saved day of month; take the date with the later day so a 31st survives a short month.
function pickAnchor(s: RecurringSuggestion): string {
  if (s.cycle === "weekly") return s.next_date;
  return Number(s.next_date.slice(8)) >= Number(s.anchor_date.slice(8)) ? s.next_date : s.anchor_date;
}

export default function SubscriptionsPage() {
  const { bundle, currency, today, userId } = useFinance();
  const toast = useToast();
  const subs = bundle.subscriptions;
  const cats = useMemo(() => categoryLookup(bundle.categories), [bundle.categories]);
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ subscription: Subscription | null; prefill: SubscriptionPrefill | null } | null>(null);
  const hiddenKey = `splitter-finance-recurring-hidden:${userId}`;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(hiddenKey);
      const list: unknown = raw ? JSON.parse(raw) : [];
      setHidden(new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []));
    } catch { setHidden(new Set()); }
  }, [hiddenKey]);

  function hide(key: string) {
    const nextSet = new Set(hidden);
    nextSet.add(key);
    setHidden(nextSet);
    try { window.localStorage.setItem(hiddenKey, JSON.stringify([...nextSet])); } catch { /* storage unavailable */ }
    toast.ok("Hidden. It won't be suggested again.");
  }

  const view = useMemo(() => {
    const active = subs.filter((s) => s.status === "active");
    const totals = subscriptionEquivalentTotals(subs);
    const next30 = forecastSubscriptionCharges(subs, today, 30);
    const nextDates = new Map<string, string | null>();
    for (const s of active) nextDates.set(s.id, nextRenewalDate(s.anchor_date, s.cycle, today));
    return { active, totals, next30, next30Total: forecastTotalCents(next30), nextDates };
  }, [subs, today]);

  const suggestions = useMemo(
    () => detectRecurring(bundle.transactions, today, subs.map((s) => s.name)).filter((x) => !hidden.has(x.key)),
    [bundle.transactions, today, subs, hidden],
  );
  const subsCat = bundle.categories.find((c) => !c.archived && c.name.trim().toLowerCase() === "subscriptions");

  const counts = useMemo(() => ({
    active: view.active.length, paused: subs.filter((s) => s.status === "paused").length, canceled: subs.filter((s) => s.status === "canceled").length,
  }), [subs, view.active.length]);
  const hasInactive = counts.paused + counts.canceled > 0;
  const effectiveFilter: Filter = hasInactive ? filter : "active";

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byName = (a: Subscription, b: Subscription) => a.name.localeCompare(b.name);
    const activeRows = subs.filter((s) => s.status === "active").sort((a, b) => {
      const da = view.nextDates.get(a.id) ?? "9999-12-31";
      const db = view.nextDates.get(b.id) ?? "9999-12-31";
      return da === db ? byName(a, b) : da < db ? -1 : 1;
    });
    const paused = subs.filter((s) => s.status === "paused").sort(byName);
    const canceled = subs.filter((s) => s.status === "canceled").sort(byName);
    const list = effectiveFilter === "active" ? activeRows : effectiveFilter === "paused" ? paused : effectiveFilter === "canceled" ? canceled : [...activeRows, ...paused, ...canceled];
    return q ? list.filter((s) => s.name.toLowerCase().includes(q)) : list;
  }, [subs, view.nextDates, effectiveFilter, query]);

  const sheetSub = sheetId ? subs.find((s) => s.id === sheetId) ?? null : null;
  const openAdd = () => setEditor({ subscription: null, prefill: null });
  const searching = query.trim() !== "";

  function rowSub(s: Subscription): string {
    if (s.status === "canceled") return "Canceled";
    const base = `${money(s.amount_cents, currency)} ${CYCLE_WORD[s.cycle]}`;
    if (s.status === "paused") return `${base} · paused`;
    const next = view.nextDates.get(s.id);
    return next ? `${base} · renews ${shortDay(next)}` : base;
  }

  const empty = subs.length === 0 && suggestions.length === 0;
  const chips: { id: Filter; label: string }[] = [
    { id: "active", label: `Active ${counts.active}` },
    ...(counts.paused ? [{ id: "paused" as const, label: `Paused ${counts.paused}` }] : []),
    ...(counts.canceled ? [{ id: "canceled" as const, label: `Canceled ${counts.canceled}` }] : []),
    { id: "all", label: "All" },
  ];

  return (
    <>
      {subs.length > 0 && (
        <Hero label="Subscriptions per month" cents={Number(view.totals.monthly_cents)} currency={currency}
          actions={<button type="button" className="btn btn-primary" onClick={openAdd}><Plus /> Add subscription</button>}>
          <Pill label="Per year" value={money(Number(view.totals.yearly_cents), currency)} />
          <Pill label="Active" value={view.active.length} />
          <Pill color="var(--gold)" label="Next 30 days" value={money(Number(view.next30Total), currency)} />
        </Hero>
      )}

      {empty ? (
        <Empty title="No subscriptions yet"
          action={<div className="fin-actions" style={{ justifyContent: "center" }}>
            <button type="button" className="btn btn-primary" onClick={openAdd}><Plus /> Add subscription</button>
            <Link className="btn" href="/finance/activity?import=1">Import bank CSV</Link>
          </div>}>
          Add the services you pay for and see every renewal before it hits.
        </Empty>
      ) : (
        <div className="dash-grid">
          <div className="dash-col">
            <Card title="All subscriptions" description={`${subs.length} tracked`}>
              {subs.length === 0 ? (
                <p className="hint">Nothing tracked yet. Add one, or track a repeat charge from the list.</p>
              ) : (
                <div className="stack">
                  {hasInactive && (
                    <div className="fin-chips fin-sub-chips" role="group" aria-label="Filter by status">
                      {chips.map((c) => (
                        <button key={c.id} type="button" className={`chip plain ${effectiveFilter === c.id ? "on" : ""}`} aria-pressed={effectiveFilter === c.id} onClick={() => setFilter(c.id)}>{c.label}</button>
                      ))}
                    </div>
                  )}
                  {subs.length > 8 && (
                    <div className="fin-toolbar">
                      <div className="fin-search">
                        <Search aria-hidden />
                        <input className="input" aria-label="Search subscriptions" placeholder="Search subscriptions" value={query} onChange={(e) => setQuery(e.target.value)} />
                      </div>
                    </div>
                  )}
                  {rows.length === 0 ? (
                    <p className="hint">{searching ? "No matches." : `No ${effectiveFilter === "all" ? "" : effectiveFilter + " "}subscriptions.`}</p>
                  ) : (
                    <div className="list">
                      {rows.map((s) => (
                        <button key={s.id} type="button" className="item clickable" onClick={() => setSheetId(s.id)}>
                          <CategoryTile category={s.category_id ? cats.get(s.category_id) : null} />
                          <div className="item-main">
                            <div className="item-title">{s.name}</div>
                            <div className="item-sub">{rowSub(s)}</div>
                          </div>
                          <div className="item-end">
                            {s.status === "paused" ? <span className="badge">Paused</span>
                              : s.status === "canceled" ? <span className="badge">Canceled</span>
                              : s.cycle === "monthly" ? <div className="v">{money(s.amount_cents, currency)}</div>
                              : <><div className="v">{money(Number(subscriptionEquivalent(s.amount_cents, s.cycle).monthly_cents), currency)}</div><div className="k">a month</div></>}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>
          <div className="dash-col">
            <Card title="Coming up" description={`${money(Number(view.next30Total), currency)} in the next 30 days`}>
              {view.next30.length === 0 ? (
                <p className="hint">Nothing renews in the next 30 days.</p>
              ) : (
                <div className="list">
                  {view.next30.slice(0, 6).map((c) => (
                    <button key={`${c.subscription_id}-${c.date}`} type="button" className="item clickable" onClick={() => setSheetId(c.subscription_id)}>
                      <DateTile date={c.date} />
                      <div className="item-main">
                        <div className="item-title">{c.name}</div>
                        <div className="item-sub">{relativeDay(c.date, today)}</div>
                      </div>
                      <div className="item-end"><div className="v">{money(c.amount_cents, currency)}</div></div>
                    </button>
                  ))}
                  {view.next30.length > 6 && <p className="hint">And {view.next30.length - 6} more</p>}
                </div>
              )}
            </Card>
            {suggestions.length > 0 && (
              <Card title="Found in your activity" description="Charges that repeat. Track them to see renewals coming.">
                <div className="list fin-sub-suggest">
                  {suggestions.slice(0, 5).map((s) => (
                    <div key={s.key} className="item">
                      <span className="icon-tile sm"><Repeat /></span>
                      <div className="item-main">
                        <div className="item-title">{s.name}</div>
                        <div className="item-sub">{money(s.amount_cents, currency)} {CYCLE_WORD[s.cycle]} · seen {s.occurrences} times</div>
                      </div>
                      <div className="item-end row-flex">
                        <button type="button" className="btn btn-sm" style={{ minHeight: 36 }}
                          onClick={() => setEditor({ subscription: null, prefill: { name: s.name, amount_cents: s.amount_cents, cycle: s.cycle, anchor_date: pickAnchor(s), category_id: subsCat?.id ?? null } })}>Track</button>
                        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Hide ${s.name}`} onClick={() => hide(s.key)}><X /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      <p className="fin-foot">Monthly figures turn weekly, quarterly and yearly plans into a monthly average.</p>

      <SubscriptionSheet open={sheetSub !== null} subscription={sheetSub} onClose={() => setSheetId(null)}
        onEdit={(s) => { setSheetId(null); setEditor({ subscription: s, prefill: null }); }} />
      <SubscriptionEditor open={editor !== null} subscription={editor?.subscription ?? null} prefill={editor?.prefill ?? null} onClose={() => setEditor(null)} />
    </>
  );
}
