"use client";
import "@/components/finance/styles/activity.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FileUp, Plus, RefreshCw, Search, X } from "lucide-react";
import { Card } from "@/components/kit";
import { Empty, Spinner } from "@/components/ui";
import { useToast } from "@/components/providers";
import { useFinance } from "@/components/finance/FinanceProvider";
import { CsvImport } from "@/components/finance/CsvImport";
import { TransactionEditor, type TxDefaults } from "@/components/finance/TransactionEditor";
import { CategoryTile, TxAmount, monthLong, weekdayDay } from "@/components/finance/kit";
import { detectRecurring } from "@/lib/finance-import";
import { categoryLookup, sortTransactions } from "@/lib/finance-selectors";
import { isReauthError, syncConnection } from "@/lib/plaid-client";
import { centsToInput, money } from "@/lib/format";
import { parseMoney } from "@/lib/split";
import type { FinanceTransaction } from "@/lib/finance-types";

const PAGE = 50;
const NUDGE_KEY = "splitter-finance-recurring-nudge";

export default function ActivityPage() {
  const router = useRouter();
  const toast = useToast();
  const { bundle, currency, today, ctx, demo, reload } = useFinance();
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState("");
  const [accountId, setAccountId] = useState("");
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [editing, setEditing] = useState<{ tx: FinanceTransaction | null; defaults?: TxDefaults } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("import") === "1") setImportOpen(true);
    const c = q.get("category");
    if (c === "uncategorized" || (c && bundle.categories.some((x) => x.id === c))) setCategory(c);
    const m = q.get("month");
    if (m && /^\d{4}-\d{2}$/.test(m)) setMonth(m);
    if (q.toString()) router.replace("/finance/activity", { scroll: false });
    try { setDismissed(sessionStorage.getItem(NUDGE_KEY)); } catch { /* storage unavailable */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setLimit(PAGE); }, [query, month, accountId, category, kind]);

  const cats = useMemo(() => categoryLookup(bundle.categories), [bundle.categories]);
  const accounts = useMemo(() => new Map(bundle.accounts.map((a) => [a.id, a])), [bundle.accounts]);
  const all = useMemo(() => sortTransactions(bundle.transactions), [bundle.transactions]);
  const months = useMemo(() => {
    const seen: string[] = [];
    for (const t of all) { const m = t.date.slice(0, 7); if (seen[seen.length - 1] !== m && !seen.includes(m)) seen.push(m); }
    return seen;
  }, [all]);
  const hasNoAccount = useMemo(() => all.some((t) => t.account_id === null), [all]);
  const usedCategoryIds = useMemo(() => new Set(all.map((t) => t.category_id).filter(Boolean)), [all]);
  const suggestions = useMemo(
    () => detectRecurring(bundle.transactions, today, bundle.subscriptions.map((s) => s.name)),
    [bundle.transactions, bundle.subscriptions, today],
  );

  const isUncat = (t: FinanceTransaction) => t.kind === "expense" && (!t.category_id || !cats.has(t.category_id));

  const view = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const parsed = needle ? parseMoney(needle) : null;
    const exact = parsed !== null && parsed > 0 ? parsed : null;
    const filtered = all.filter((t) => {
      if (month && !t.date.startsWith(month)) return false;
      if (accountId === "none" ? t.account_id !== null : accountId && t.account_id !== accountId) return false;
      if (category === "uncategorized" ? !isUncat(t) : category && !(t.kind === "expense" && t.category_id === category)) return false;
      if (kind && t.kind !== kind) return false;
      if (needle) {
        const cat = t.category_id ? cats.get(t.category_id)?.name ?? "" : "";
        const acct = t.account_id ? accounts.get(t.account_id)?.name ?? "" : "";
        const hit = t.description.toLowerCase().includes(needle) || cat.toLowerCase().includes(needle) || acct.toLowerCase().includes(needle)
          || centsToInput(t.amount_cents).includes(needle) || (exact !== null && t.amount_cents === exact);
        if (!hit) return false;
      }
      return true;
    });
    let inC = 0n, outC = 0n, transfers = 0;
    const days = new Map<string, { out: number; in: number }>();
    for (const t of filtered) {
      const d = days.get(t.date) ?? { out: 0, in: 0 };
      if (t.kind === "income") { inC += BigInt(t.amount_cents); d.in += t.amount_cents; }
      else if (t.kind === "expense") { outC += BigInt(t.amount_cents); d.out += t.amount_cents; }
      else transfers += 1;
      days.set(t.date, d);
    }
    return { filtered, inCents: Number(inC), outCents: Number(outC), net: Number(inC - outC), transfers, days };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, query, month, accountId, category, kind, cats, accounts]);

  const uncatCount = useMemo(
    () => (category === "" ? all.filter((t) => (!month || t.date.startsWith(month)) && isUncat(t)).length : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, month, category, cats],
  );

  const anyFilter = Boolean(query.trim() || month || accountId || category || kind);
  const clear = () => { setQuery(""); setMonth(""); setAccountId(""); setCategory(""); setKind(""); };
  const shown = view.filtered.slice(0, limit);
  const groups = useMemo(() => {
    const out: { date: string; items: FinanceTransaction[] }[] = [];
    for (const t of shown) {
      const last = out[out.length - 1];
      if (last && last.date === t.date) last.items.push(t); else out.push({ date: t.date, items: [t] });
    }
    return out;
  }, [shown]);

  const openAdd = () => setEditing({
    tx: null,
    defaults: {
      category_id: category && category !== "uncategorized" ? category : undefined,
      account_id: accountId && accountId !== "none" ? accountId : undefined,
      kind: kind === "expense" || kind === "income" || kind === "transfer" ? kind : undefined,
    },
  });

  async function sync() {
    setSyncing(true); setSyncStatus("");
    let upserted = 0, reauthShown = false, failed = false;
    try {
      for (const c of bundle.connections) {
        if (c.status === "reauth") {
          if (!reauthShown) { reauthShown = true; toast.err(new Error(`${c.institution} needs you to sign in again. Fix it in Accounts.`)); }
          continue;
        }
        try {
          const r = await syncConnection(ctx, c.id, setSyncStatus);
          upserted += r.upserted;
        } catch (e) {
          if (isReauthError(e)) {
            if (!reauthShown) { reauthShown = true; toast.err(new Error(`${c.institution} needs you to sign in again. Fix it in Accounts.`)); }
            continue;
          }
          failed = true; toast.err(e); break;
        }
      }
      await reload();
      if (!failed && !reauthShown) toast.ok(upserted ? `Synced ${upserted} transactions` : "Everything is up to date");
    } finally { setSyncing(false); setSyncStatus(""); }
  }

  const nudgeKey = suggestions.map((s) => s.key).join("|");
  const showRecurring = suggestions.length > 0 && dismissed !== nudgeKey;
  const names = suggestions.map((s) => s.name);
  const recurringText = names.length === 1 ? `${names[0]} looks like a subscription.`
    : names.length === 2 ? `${names[0]} and ${names[1]} look like subscriptions.`
    : `${names[0]}, ${names[1]} and ${names.length - 2} more look like subscriptions.`;

  const empty = bundle.transactions.length === 0;
  const addBtn = <button type="button" className="btn btn-primary" onClick={openAdd}><Plus /> Add transaction</button>;
  const importBtn = <button type="button" className="btn" onClick={() => setImportOpen(true)}><FileUp /> Import CSV</button>;

  return (
    <>
      <section className="card">
        <div className="card-body stack">
          <div className="fin-actions">
            {addBtn}
            {importBtn}
            {bundle.connections.length > 0 && !demo && (
              <button type="button" className="btn" disabled={syncing} onClick={() => void sync()}>
                {syncing ? <Spinner /> : <RefreshCw />} {syncing ? "Syncing" : "Sync"}
              </button>
            )}
          </div>
          {syncing && syncStatus && <div className="hint" role="status">{syncStatus}</div>}

          {!empty && (
            <div className="fin-toolbar">
              <div className="fin-search">
                <Search aria-hidden />
                <input className="input" type="search" aria-label="Search transactions" placeholder="Search merchant, category or amount" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="fin-act-filters">
                <select className="select" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
                  <option value="">All time</option>
                  {month && !months.includes(month) && <option value={month}>{monthLong(month)}</option>}
                  {months.map((m) => <option key={m} value={m}>{monthLong(m)}</option>)}
                </select>
                <select className="select" aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">All accounts</option>
                  {hasNoAccount && <option value="none">No account</option>}
                  {bundle.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` ··${a.last4}` : ""}</option>)}
                </select>
                <select className="select" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">All categories</option>
                  <option value="uncategorized">Uncategorized</option>
                  {(["needs", "wants", "savings"] as const).map((k) => {
                    const list = bundle.categories.filter((c) => c.kind === k && !c.archived);
                    return list.length ? <optgroup key={k} label={k === "needs" ? "Needs" : k === "wants" ? "Wants" : "Savings"}>
                      {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup> : null;
                  })}
                  {(() => {
                    const arch = bundle.categories.filter((c) => c.archived && (usedCategoryIds.has(c.id) || c.id === category));
                    return arch.length ? <optgroup label="Archived">{arch.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup> : null;
                  })()}
                </select>
                <select className="select" aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">All types</option>
                  <option value="expense">Spending</option>
                  <option value="income">Income</option>
                  <option value="transfer">Transfers</option>
                </select>
              </div>
            </div>
          )}
          {anyFilter && (
            <div className="row-flex" style={{ justifyContent: "space-between", gap: 8 }}>
              <span className="hint">Showing {view.filtered.length} of {all.length}</span>
              <button type="button" className="btn btn-ghost btn-sm" style={{ minHeight: 36 }} onClick={clear}>Clear filters</button>
            </div>
          )}
        </div>
        {!empty && (
          <div className="fin-kpis">
            <div><div className="k">In</div><div className="v num pos">{money(view.inCents, currency)}</div></div>
            <div><div className="k">Out</div><div className="v num">{money(view.outCents, currency)}</div></div>
            <div>
              <div className="k">Net</div>
              <div className={`v num${view.net < 0 ? " neg" : ""}`}>{money(view.net, currency, { sign: true })}</div>
              {view.transfers > 0 && <div className="s">{view.transfers} transfers not counted</div>}
            </div>
          </div>
        )}
      </section>

      {!empty && uncatCount > 0 && (
        <button type="button" className="banner fin-act-nudge" onClick={() => setCategory("uncategorized")}>
          <span>{uncatCount} expenses need a category</span><strong>Review</strong>
        </button>
      )}

      {showRecurring && (
        <Card title="Repeat charges spotted" description={recurringText}
          action={<div className="row-flex" style={{ gap: 6 }}>
            <Link className="btn btn-sm" style={{ minHeight: 36 }} href="/finance/subscriptions">Review</Link>
            <button type="button" className="btn btn-icon btn-ghost" style={{ minWidth: 36, minHeight: 36 }} aria-label="Dismiss"
              onClick={() => { try { sessionStorage.setItem(NUDGE_KEY, nudgeKey); } catch { /* ignore */ } setDismissed(nudgeKey); }}><X /></button>
          </div>}>
          {null}
        </Card>
      )}

      {empty ? (
        <Card>
          <Empty title="No transactions yet" action={<div className="fin-actions" style={{ justifyContent: "center" }}>{addBtn}{importBtn}</div>}>
            Add one by hand, import a CSV from your bank, or link a bank in Accounts.
          </Empty>
        </Card>
      ) : view.filtered.length === 0 ? (
        <Card>
          <Empty title="Nothing matches" action={<button type="button" className="btn" onClick={clear}>Clear filters</button>}>
            Try a different search or clear the filters.
          </Empty>
        </Card>
      ) : (
        <Card>
          {groups.map((g) => {
            const d = view.days.get(g.date);
            return (
              <div key={g.date}>
                <div className="fin-group-head">
                  <span>{weekdayDay(g.date, today)}</span>
                  {d && d.out > 0 ? <span className="num">{money(d.out, currency)}</span>
                    : d && d.in > 0 ? <span className="num pos">+{money(d.in, currency)}</span> : null}
                </div>
                <div className="list">
                  {g.items.map((t) => {
                    const c = t.category_id ? cats.get(t.category_id) : null;
                    const label = t.kind === "expense" ? c?.name ?? "Uncategorized" : t.kind === "income" ? "Income" : "Transfer";
                    const acct = t.account_id ? accounts.get(t.account_id)?.name : undefined;
                    return (
                      <button type="button" className="item clickable" key={t.id} onClick={() => setEditing({ tx: t })}>
                        <CategoryTile category={c} income={t.kind === "income"} transfer={t.kind === "transfer"} />
                        <div className="item-main">
                          <div className="item-title">{t.description}</div>
                          <div className="item-sub">{[label, acct].filter(Boolean).join(" · ")}{t.pending ? " · Pending" : ""}</div>
                        </div>
                        <div className="item-end"><div className="v"><TxAmount tx={t} currency={currency} /></div></div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {view.filtered.length > limit && (
            <div className="stack-sm" style={{ marginTop: 14 }}>
              <button type="button" className="btn" style={{ width: "100%", minHeight: 40 }} onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, view.filtered.length - limit)} more</button>
              <div className="hint" style={{ textAlign: "center" }}>{shown.length} of {view.filtered.length}</div>
            </div>
          )}
        </Card>
      )}

      <p className="fin-foot">Transfers between your own accounts never count as spending or income.</p>

      <TransactionEditor open={editing !== null} tx={editing?.tx ?? null} defaults={editing?.defaults} onClose={() => setEditing(null)} />
      <CsvImport open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
