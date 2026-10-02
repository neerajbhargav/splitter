"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Empty, Loading } from "@/components/ui";
import { friendly, loadOverview, useLiveRefresh, type Overview } from "@/lib/data";
import { CATEGORIES, category } from "@/lib/categories";
import { money, shortDate } from "@/lib/format";
import type { Expense } from "@/lib/types";

const PAGE_SIZE = 50;
type Filters = { query: string; group: string; category: string; from: string; to: string; type: string };
type SearchEntry = { expense: Expense; groupName: string; payerNames: string[]; text: string };
const INITIAL_FILTERS: Filters = { query: "", group: "all", category: "all", from: "", to: "", type: "all" };

function normalized(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function filterEntries(entries: SearchEntry[], filters: Filters): SearchEntry[] {
  if (filters.from && filters.to && filters.from > filters.to) return [];
  const terms = normalized(filters.query).trim().split(/\s+/).filter(Boolean);
  return entries.filter(({ expense: e, text }) =>
    !e.deleted_at &&
    (filters.group === "all" || e.group_id === filters.group) &&
    (filters.category === "all" || e.category === filters.category) &&
    (!filters.from || e.expense_date >= filters.from) &&
    (!filters.to || e.expense_date <= filters.to) &&
    (filters.type === "all" || (filters.type === "payment" ? e.is_payment : !e.is_payment)) &&
    terms.every((term) => text.includes(term)),
  );
}

export default function SearchPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const request = useRef(0);

  const reload = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await loadOverview(0);
      if (id === request.current) {
        setData(next);
        setError(null);
      }
    } catch (err) {
      if (id === request.current) setError(friendly(err instanceof Error ? err.message : String(err)));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => { ++request.current; };
  }, [reload]);
  useLiveRefresh("search-page", [{ table: "activity" }, { table: "expenses" }, { table: "groups" }, { table: "group_members" }], reload);

  const entries = useMemo<SearchEntry[]>(() => {
    if (!data) return [];
    const groups = new Map(data.groups.map((g) => [g.id, g]));
    const members = new Map(data.members.map((m) => [m.id, m]));
    // loadOverview uses the signed-in client's RLS-scoped, paginated queries.
    // Index only members actually involved in each expense, not everyone in its group.
    return data.expenses.filter((e) => !e.deleted_at && groups.has(e.group_id)).map((expense) => {
      const groupName = groups.get(expense.group_id)!.name;
      const payerNames = expense.expense_payers.map((p) => members.get(p.member_id)?.display_name ?? "Former member");
      const involved = [...expense.expense_payers, ...expense.expense_splits]
        .map((p) => members.get(p.member_id)?.display_name ?? "").join(" ");
      return {
        expense, groupName, payerNames,
        text: normalized([expense.description, expense.notes ?? "", groupName, involved,
          expense.category, category(expense.category).label, expense.is_payment ? "payment settlement" : "expense"].join(" ")),
      };
    }).sort((a, b) => b.expense.expense_date.localeCompare(a.expense.expense_date) ||
      b.expense.created_at.localeCompare(a.expense.created_at) || a.expense.id.localeCompare(b.expense.id));
  }, [data]);
  const matches = useMemo(() => filterEntries(entries, filters), [entries, filters]);
  const invalidDates = !!(filters.from && filters.to && filters.from > filters.to);
  const hasFilters = Object.entries(filters).some(([key, value]) => value !== INITIAL_FILTERS[key as keyof Filters]);
  const change = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setLimit(PAGE_SIZE);
  };
  const clear = () => { setFilters(INITIAL_FILTERS); setLimit(PAGE_SIZE); };

  if (!data && loading) return <Loading label="Loading expenses across your groups" />;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Across all your groups</div>
          <h1 className="page-title">Search</h1>
          <p className="muted small">Find expenses and payments by description, notes, group, person or category.</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} /> {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {error && <div className="banner neg" role="alert">
        <div>{data ? "Couldn't refresh. Results below are from the last successful load. " : "Couldn't load your expenses. "}{error}</div>
        <button type="button" className="btn btn-sm" onClick={() => void reload()} disabled={loading}>Try again</button>
      </div>}
      {data && <>
        <section className="card" aria-label="Search filters">
          <div className="card-body stack">
            <div className="field">
              <label className="label" htmlFor="global-search">Search all groups</label>
              <div style={{ position: "relative" }}>
                <Search width={16} height={16} style={{ position: "absolute", left: 11, top: 12, color: "var(--ink-3)" }} aria-hidden />
                <input id="global-search" type="search" className="input" style={{ paddingLeft: 34 }}
                  placeholder="Groceries, Wi-Fi, a person's name..." maxLength={200} autoComplete="off"
                  value={filters.query} onChange={(e) => change("query", e.target.value)} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label className="label" htmlFor="search-group">Group</label>
                <select id="search-group" className="select" value={filters.group} onChange={(e) => change("group", e.target.value)}>
                  <option value="all">All groups</option>
                  {data.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="search-category">Category</label>
                <select id="search-category" className="select" value={filters.category} onChange={(e) => change("category", e.target.value)}>
                  <option value="all">All categories</option>
                  {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  <option value="payment">Payments</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label className="label" htmlFor="search-from">From date</label>
                <input id="search-from" type="date" className="input" value={filters.from}
                  aria-invalid={invalidDates} onChange={(e) => change("from", e.target.value)} />
              </div>
              <div className="field">
                <label className="label" htmlFor="search-to">To date</label>
                <input id="search-to" type="date" className="input" value={filters.to}
                  aria-invalid={invalidDates} onChange={(e) => change("to", e.target.value)} />
              </div>
            </div>
            <div className="between wrap">
              <div className="field" style={{ flex: "1 1 180px", maxWidth: 260 }}>
                <label className="label" htmlFor="search-type">Entry type</label>
                <select id="search-type" className="select" value={filters.type} onChange={(e) => change("type", e.target.value)}>
                  <option value="all">Expenses and payments</option>
                  <option value="expense">Expenses only</option>
                  <option value="payment">Payments only</option>
                </select>
              </div>
              {hasFilters && <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>Clear filters</button>}
            </div>
            {invalidDates && <div className="banner neg" role="alert">From date must be on or before To date.</div>}
          </div>
        </section>
        <section className="card" aria-label="Search results" aria-busy={loading}>
          <div className="card-head">
            <span className="card-title">Results</span>
            <span className="small faint" role="status" aria-live="polite" aria-atomic="true">
              {invalidDates ? "Check the date range" : `${matches.length} ${matches.length === 1 ? "match" : "matches"}`}
            </span>
          </div>
          <div className="card-body">
            {!data.groups.length ? <Empty title="No groups yet" action={<Link href="/groups/new" className="btn btn-primary">Create a group</Link>}>
              Create or join a group to start tracking shared expenses.
            </Empty> : !entries.length ? <Empty title="No expenses yet" action={<Link href="/groups" className="btn">Go to groups</Link>}>
              Expenses and payments from your groups will appear here.
            </Empty> : !matches.length ? <Empty title={invalidDates ? "Choose a valid date range" : "No matches"}
              action={hasFilters && <button type="button" className="btn btn-ghost" onClick={clear}>Clear filters</button>}>
              {invalidDates ? "The start date can't come after the end date." : "Try a different search or broaden the filters."}
            </Empty> : <>
              <div className="list">
                {matches.slice(0, limit).map(({ expense: e, groupName, payerNames }) => {
                  const cat = category(e.category);
                  const Icon = cat.icon;
                  const { mon, day } = shortDate(e.expense_date);
                  return (
                    <Link key={e.id} className="item clickable" href={`/groups/${e.group_id}?e=${e.id}`}>
                      <div className="datebox" aria-label={e.expense_date}><div className="m">{mon}</div><div className="d">{day}</div></div>
                      <span className={`icon-tile ${e.is_payment ? "gold" : ""}`}><Icon aria-hidden /></span>
                      <div className="item-main">
                        <div className="item-title clamp-2">{e.description}</div>
                        <div className="item-sub wrap2">{groupName} · {e.expense_date} · {cat.label}</div>
                        <div className="item-sub wrap2">{payerNames.join(", ") || "Unknown payer"} paid</div>
                        {e.notes && <div className="item-sub clamp-2">{e.notes}</div>}
                      </div>
                      <div className="item-end">
                        <div className="k">{e.is_payment ? "payment" : "total"}</div>
                        <div className={`v ${e.is_payment ? "gold" : ""}`}>{money(e.amount_cents, e.currency)}</div>
                      </div>
                    </Link>
                  );
                })}
              </div>
              <div className="between wrap" style={{ marginTop: 16 }}>
                <span className="small faint">Showing {Math.min(limit, matches.length)} of {matches.length}. Select an entry for details.</span>
                {limit < matches.length && <button type="button" className="btn btn-sm" onClick={() => setLimit((n) => n + PAGE_SIZE)}>Load more</button>}
              </div>
            </>}
          </div>
        </section>
      </>}
    </main>
  );
}
