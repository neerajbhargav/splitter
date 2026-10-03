"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { FileUp, Landmark, PenLine, Plus } from "lucide-react";
import { Card } from "@/components/kit";
import { Donut, CHART_COLORS, type Slice } from "@/components/charts";
import { useFinance } from "@/components/finance/FinanceProvider";
import { AccountEditor, formatApr } from "@/components/finance/AccountEditor";
import { BankLinks } from "@/components/finance/BankLinks";
import { AccountIcon, Hero, Pill, moneyTight, relativeDay } from "@/components/finance/kit";
import { accountValueCents, netWorth } from "@/lib/finance-insights";
import { isLiability, type AccountType, type FinanceAccount, type FinanceConnection } from "@/lib/finance-types";
import { money } from "@/lib/format";

const GROUPS: { id: string; title: string; types: AccountType[]; owed?: boolean }[] = [
  { id: "cash", title: "Cash", types: ["checking", "savings", "cash"] },
  { id: "investments", title: "Investments", types: ["investment"] },
  { id: "credit", title: "Credit cards", types: ["credit"], owed: true },
  { id: "loans", title: "Loans", types: ["loan"], owed: true },
];

const ALLOCATION: { type: AccountType; name: string }[] = [
  { type: "checking", name: "Checking" },
  { type: "savings", name: "Savings" },
  { type: "cash", name: "Cash" },
  { type: "investment", name: "Investments" },
];

const SOURCE_LABEL: Record<FinanceAccount["source"], string> = { plaid: "Linked", csv: "Imported", manual: "Manual" };

/** Local YYYY-MM-DD for a timestamp. */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function updatedLabel(iso: string, today: string): string {
  const rel = relativeDay(localDay(iso), today);
  // "Today" -> "today", "3 days ago" stays, "Oct 2" stays.
  return /^[A-Z][a-z]{2} \d/.test(rel) ? rel : rel.charAt(0).toLowerCase() + rel.slice(1);
}

type Row = { account: FinanceAccount; value: number; holdings: number };

export default function FinanceAccounts() {
  const { bundle, currency, today } = useFinance();
  const [editing, setEditing] = useState<{ account: FinanceAccount | null } | null>(null);

  const view = useMemo(() => {
    const worth = netWorth(bundle.accounts, bundle.holdings);
    const holdingCount = new Map<string, number>();
    for (const h of bundle.holdings) holdingCount.set(h.account_id, (holdingCount.get(h.account_id) ?? 0) + 1);
    const rows: Row[] = bundle.accounts.map((account) => ({
      account,
      value: accountValueCents(account, bundle.holdings),
      holdings: account.type === "investment" ? holdingCount.get(account.id) ?? 0 : 0,
    }));
    const groups = GROUPS.map((g) => {
      const items = rows.filter((r) => g.types.includes(r.account.type)).sort((a, b) => b.value - a.value || a.account.name.localeCompare(b.account.name));
      return { ...g, items, total: items.reduce((sum, r) => sum + r.value, 0) };
    }).filter((g) => g.items.length > 0);
    const slices: Slice[] = ALLOCATION
      .map((a, i) => ({ key: a.type, name: a.name, value: worth.byType[a.type], color: CHART_COLORS[i % CHART_COLORS.length] }))
      .filter((s) => s.value > 0);
    const connections = new Map<string, FinanceConnection>(bundle.connections.map((c) => [c.id, c]));
    return { worth, groups, slices, connections };
  }, [bundle.accounts, bundle.holdings, bundle.connections]);

  const { worth, groups, slices } = view;
  const hasAccounts = bundle.accounts.length > 0;
  const openNew = () => setEditing({ account: null });

  return (
    <>
      {hasAccounts ? (
        <Hero label="Net worth" cents={worth.net} currency={currency} tone="auto"
          actions={<><button type="button" className="btn btn-primary" onClick={openNew}><Plus /> Add account</button>
            <Link href="/finance/activity?import=1" className="btn"><FileUp /> Import CSV</Link></>}>
          <Pill color="var(--pos)" label="Assets" value={moneyTight(worth.assets, currency)} />
          <Pill color="var(--neg)" label="Debt" value={moneyTight(worth.liabilities, currency)} />
          <Pill color="var(--chart-2)" label="Cash" value={moneyTight(worth.liquid, currency)} />
        </Hero>
      ) : (
        <EmptyAccounts onAdd={openNew} />
      )}

      {!hasAccounts ? (
        <div id="linked-banks" style={{ scrollMarginTop: 80 }}>
          <BankLinks />
        </div>
      ) : (
      <div className="dash-grid">
          <div className="dash-col">
            {groups.map((g) => (
              <Card key={g.id} title={g.title} description={`${g.items.length} account${g.items.length === 1 ? "" : "s"}${g.owed ? " · owed" : ""}`}
                action={<span className={`num ${g.owed && g.total > 0 ? "neg" : g.total < 0 ? "neg" : ""}`} style={{ fontSize: 15, whiteSpace: "nowrap" }}>{money(g.total, currency)}</span>}>
                <div className="list">
                  {g.items.map((r) => <AccountRow key={r.account.id} row={r} currency={currency} today={today}
                    connection={r.account.connection_id ? view.connections.get(r.account.connection_id) : undefined}
                    onOpen={() => setEditing({ account: r.account })} />)}
                </div>
              </Card>
            ))}
          </div>

        <div className="dash-col">
          {slices.length >= 2 && (
            <Card title="Where your assets sit" description="By account type">
              <Donut data={slices} currency={currency} center={moneyTight(slices.reduce((s, x) => s + x.value, 0), currency)} centerLabel="Assets" height={170} />
            </Card>
          )}
          <BankLinks />
        </div>
      </div>
      )}

      <p className="hint" style={{ textAlign: "center", padding: "0 12px" }}>
        Balances you type in are snapshots, so refresh them now and then. Linked banks update each time they sync.
      </p>

      <AccountEditor open={editing !== null} account={editing?.account ?? null} onClose={() => setEditing(null)} />
    </>
  );
}

function AccountRow({ row, currency, today, connection, onOpen }: {
  row: Row; currency: string; today: string; connection?: FinanceConnection; onOpen: () => void;
}) {
  const { account: a, value, holdings } = row;
  const owed = isLiability(a.type);
  const touched = a.source === "plaid" && connection?.last_synced_at && connection.last_synced_at > a.updated_at ? connection.last_synced_at : a.updated_at;
  const sub = [a.institution.trim(), a.last4 ? `··${a.last4}` : "", SOURCE_LABEL[a.source], `updated ${updatedLabel(touched, today)}`].filter(Boolean).join(" · ");
  const hasTerms = a.apr_bps !== null && a.minimum_cents !== null;

  return (
    <button type="button" className="item clickable" onClick={onOpen} aria-label={`Edit ${a.name}`}
      style={{ width: "calc(100% + 20px)", textAlign: "left", background: "none", border: 0, font: "inherit", color: "inherit", alignItems: owed ? "flex-start" : "center" }}>
      <AccountIcon type={a.type} gold={a.source === "plaid" && connection?.status === "reauth"} />
      <div className="item-main">
        <div className="item-title">{a.name}</div>
        <div className="item-sub wrap2">{sub}</div>
        {owed && (hasTerms ? (
          <div className="item-sub">{formatApr(a.apr_bps!)}% APR · {moneyTight(a.minimum_cents!, currency)} min{a.in_payoff ? "" : " · not in payoff plan"}</div>
        ) : a.in_payoff && value > 0 ? (
          <div className="item-sub gold wrap2">Add APR and minimum to plan payoff</div>
        ) : !a.in_payoff ? (
          <div className="item-sub">Not in payoff plan</div>
        ) : null)}
      </div>
      <div className="item-end">
        <div className={`v ${owed ? (value > 0 ? "neg" : "faint") : value < 0 ? "neg" : ""}`}>{money(value, currency)}</div>
        {holdings > 0 && <div className="k">from {holdings} holding{holdings === 1 ? "" : "s"}</div>}
      </div>
    </button>
  );
}

function EmptyAccounts({ onAdd }: { onAdd: () => void }) {
  const ways = [
    { icon: <PenLine />, title: "Add by hand", body: "Type in a balance for checking, savings, cards or loans. Quickest way to see your net worth.",
      action: <button type="button" className="btn btn-sm btn-primary" style={{ minHeight: 36 }} onClick={onAdd}><Plus /> Add account</button> },
    { icon: <FileUp />, title: "Import a CSV", body: "Any bank's export works. Your transactions land in Activity.",
      action: <Link href="/finance/activity?import=1" className="btn btn-sm" style={{ minHeight: 36 }}><FileUp /> Import CSV</Link> },
    { icon: <Landmark />, title: "Link a bank", body: "Balances and transactions stay current on their own, where linking is available.",
      action: <button type="button" className="btn btn-sm" style={{ minHeight: 36 }}
        onClick={() => document.getElementById("linked-banks")?.scrollIntoView({ behavior: "smooth", block: "start" })}><Landmark /> Link a bank</button> },
  ];
  return (
    <section className="card">
      <div className="card-body" style={{ padding: "26px 20px" }}>
        <div className="serif" style={{ fontSize: 30, lineHeight: 1.1 }}>Bring your accounts in.</div>
        <p className="muted" style={{ marginTop: 8, maxWidth: 520 }}>Pick whatever is easiest. You can mix all three.</p>
        <div className="list" style={{ marginTop: 14 }}>
          {ways.map((w) => (
            <div className="item" key={w.title} style={{ alignItems: "flex-start" }}>
              <span className="icon-tile gold">{w.icon}</span>
              <div className="item-main">
                <div className="item-title" style={{ whiteSpace: "normal" }}>{w.title}</div>
                <div className="hint" style={{ marginTop: 2 }}>{w.body}</div>
                <div style={{ marginTop: 10 }}>{w.action}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
