"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, CalendarClock, ChevronRight, Plus, Users } from "lucide-react";
import { useMe, useToast } from "@/components/providers";
import { useQuickAdd } from "@/components/Shell";
import { Avatar, Loading } from "@/components/ui";
import { ActivityList } from "@/components/ActivityList";
import { GroupRow } from "@/components/GroupRow";
import { BigMoney, Card, Progress } from "@/components/kit";
import { CHART_COLORS, Donut, MonthlyBars, type Slice } from "@/components/charts";
import { loadOverview, useLiveRefresh, type Overview } from "@/lib/data";
import { summarize } from "@/lib/overview";
import { category, groupKind } from "@/lib/categories";
import { greeting, money } from "@/lib/format";

export default function Dashboard() {
  const me = useMe();
  const toast = useToast();
  const quick = useQuickAdd();
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);

  const reload = useCallback(() => {
    loadOverview(12).then(setData).catch((e) => toast.err(e));
  }, [toast]);
  useEffect(reload, [reload]);
  useLiveRefresh("dashboard", [{ table: "activity" }, { table: "groups" }, { table: "group_members" }, { table: "upcoming_bills" }], reload);

  const sum = useMemo(() => (data ? summarize(data, me.id) : null), [data, me.id]);

  const view = useMemo(() => {
    if (!data || !sum) return null;
    const currencies = Object.keys(sum.totals);
    const cur = currencies.includes(me.profile?.default_currency ?? "") ? me.profile!.default_currency : currencies[0] ?? data.groups[0]?.currency ?? "USD";
    const t = sum.totals[cur] ?? { owe: 0, owed: 0 };
    const myIds = new Set(data.members.filter((m) => m.user_id === me.id).map((m) => m.id));
    const inCur = new Set(data.groups.filter((g) => g.currency === cur).map((g) => g.id));
    const spend = data.expenses.filter((e) => !e.deleted_at && !e.is_payment && inCur.has(e.group_id));

    // last 6 months: group total + my share
    const now = new Date();
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
      return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleDateString("en-US", { month: "short" }), total: 0, mine: 0 };
    });
    for (const e of spend) {
      const m = months.find((x) => e.expense_date.startsWith(x.key));
      if (!m) continue;
      m.total += e.amount_cents;
      m.mine += e.expense_splits.filter((s) => myIds.has(s.member_id)).reduce((a, s) => a + s.amount_cents, 0);
    }
    const thisMonth = months[5];

    // my share by category (all time)
    const byCat = new Map<string, number>();
    for (const e of spend) {
      const mine = e.expense_splits.filter((s) => myIds.has(s.member_id)).reduce((a, s) => a + s.amount_cents, 0);
      if (mine) byCat.set(e.category, (byCat.get(e.category) ?? 0) + mine);
    }
    const cats: Slice[] = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ key: k, name: category(k).label, value: v, color: CHART_COLORS[i % CHART_COLORS.length] }));

    // who owes what
    const people: Slice[] = [
      ...sum.owesYou.filter((p) => p.currency === cur).map((p, i) => ({ key: p.key, name: `${p.name} owes you`, value: p.amount, color: `var(--pos-${(i % 6) + 1})` })),
      ...sum.youOwe.filter((p) => p.currency === cur).map((p, i) => ({ key: p.key, name: `You owe ${p.name}`, value: -p.amount, color: `var(--neg-${(i % 6) + 1})` })),
    ];

    // upcoming bills where I have a share
    const groupName = new Map(data.groups.map((g) => [g.id, g]));
    const upcoming = data.upcoming
      .map((b) => {
        const mine = b.upcoming_bill_shares.find((s) => myIds.has(s.member_id));
        const paid = b.upcoming_bill_shares.filter((s) => s.paid_at);
        return { b, g: groupName.get(b.group_id), mine, paidCount: paid.length, paidAmt: paid.reduce((a, s) => a + s.amount_cents, 0) };
      })
      .filter((x) => x.g && x.mine);

    return { cur, t, balance: t.owed - t.owe, months, thisMonth, cats, people, upcoming };
  }, [data, sum, me.id, me.profile]);

  if (!data || !sum || !view) return <Loading />;
  const first = (me.profile?.display_name || "").split(" ")[0];

  if (!data.groups.length) {
    return (
      <main className="page page-narrow">
        <div className="eyebrow">{greeting()}{first ? `, ${first}` : ""}</div>
        <h1 className="page-title">Start your first group.</h1>
        <p className="page-sub">Make a group for your apartment, a trip, or anyone you share costs with. Add people by name now and send the invite link whenever you like.</p>
        <div className="row-flex wrap" style={{ marginTop: 24 }}>
          <Link href="/groups/new" className="btn btn-primary btn-lg"><Plus /> Create a group</Link>
        </div>
      </main>
    );
  }

  const { cur, t, balance } = view;
  const settleTarget = sum.groups.find((g) => g.myNet !== 0)?.group.id;

  return (
    <main className="page">
      <div className="eyebrow">{greeting()}{first ? `, ${first}` : ""}</div>

      <section className="card">
        <div className="hero-bal">
          <div className="hb-label">{balance > 0 ? "You're owed overall" : balance < 0 ? "You owe overall" : "Total balance"}</div>
          <div className={`big ${balance > 0 ? "pos" : balance < 0 ? "neg" : ""}`}><BigMoney cents={balance} currency={cur} /></div>
          <div className="sub">
            <span className="pill-stat"><i className="dot" style={{ background: "var(--pos)" }} /> Owed to you <b className="num">{money(t.owed, cur)}</b></span>
            <span className="pill-stat"><i className="dot" style={{ background: "var(--neg)" }} /> You owe <b className="num">{money(t.owe, cur)}</b></span>
          </div>
          <div className="hero-actions">
            <button type="button" className="btn btn-primary" onClick={() => quick.open()}><Plus /> Add expense</button>
            <button type="button" className="btn" onClick={() => router.push(settleTarget ? `/groups/${settleTarget}?tab=balances` : "/groups")}><ArrowUpRight /> Settle up</button>
            <Link href="/groups/new" className="btn hide-mobile"><Users /> New group</Link>
          </div>
        </div>
      </section>

      <div className="dash-grid">
        <div className="dash-col">
          {view.upcoming.length > 0 && (
            <Card title={<span className="row-flex" style={{ gap: 8 }}><CalendarClock width={16} height={16} className="gold" /> Upcoming bills</span>} description="Not in balances yet. Tick your share once you've paid it.">
              <div className="list">
                {view.upcoming.map(({ b, g, mine, paidCount, paidAmt }) => {
                  const overdue = b.due_date && b.due_date < new Date().toISOString().slice(0, 10);
                  return (
                    <Link key={b.id} href={`/groups/${b.group_id}`} className="item clickable" style={{ alignItems: "flex-start" }}>
                      <span className="icon-tile">{(() => { const I = category(b.category).icon; return <I />; })()}</span>
                      <div className="item-main">
                        <div className="item-title" style={{ whiteSpace: "normal" }}>{b.title}</div>
                        <div className={`item-sub wrap2 ${overdue ? "neg" : ""}`}>{b.due_date ? `${overdue ? "Overdue since" : "Due"} ${new Date(b.due_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "No due date"} · {g!.name}</div>
                        <div style={{ marginTop: 8 }}><Progress value={paidAmt} max={b.amount_cents} size="sm" /></div>
                        <div className="tiny faint" style={{ marginTop: 4 }}>{paidCount} of {b.upcoming_bill_shares.length} paid · {money(paidAmt, g!.currency)} of {money(b.amount_cents, g!.currency)}</div>
                      </div>
                      <div className="item-end">
                        <div className="v">{money(mine?.amount_cents ?? 0, g!.currency)}</div>
                        <div className="k">{mine?.paid_at ? "you paid ✓" : "your share"}</div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}

          <Card title="Who owes what" description={`Across all your groups, in ${cur}`}>
            <Donut data={view.people.map((p) => ({ ...p, value: Math.abs(p.value) }))} currency={cur}
              center={money(Math.abs(balance), cur)} centerLabel={balance > 0 ? "owed to you" : balance < 0 ? "you owe" : "all settled"} />
          </Card>

          <Card title="Spending" description={`Last 6 months · this month your share is ${money(view.thisMonth.mine, cur)} of ${money(view.thisMonth.total, cur)}`}>
            <MonthlyBars data={view.months} currency={cur} />
            <div className="row-flex small faint" style={{ gap: 16, marginTop: 6 }}>
              <span className="row-flex" style={{ gap: 6 }}><i className="sw" style={{ width: 10, height: 10, borderRadius: 3, background: "var(--bar-muted-2)", display: "inline-block" }} /> Group total</span>
              <span className="row-flex" style={{ gap: 6 }}><i className="sw" style={{ width: 10, height: 10, borderRadius: 3, background: "var(--chart-1)", display: "inline-block" }} /> Your share</span>
            </div>
          </Card>

          {view.cats.length > 0 && (
            <Card title="Where your money goes" description="Your share by category, all time">
              <Donut data={view.cats} currency={cur} center={money(view.cats.reduce((a, c) => a + c.value, 0), cur)} centerLabel="your share" />
            </Card>
          )}
        </div>

        <div className="dash-col">
          <Card title="Groups" action={<Link href="/groups/new" className="btn btn-ghost btn-sm"><Plus /> New</Link>}>
            <div className="list">{sum.groups.map((g) => <GroupRow key={g.group.id} s={g} />)}</div>
          </Card>

          {(sum.owesYou.length > 0 || sum.youOwe.length > 0) && (
            <Card title="People">
              <div className="list">
                {[...sum.owesYou, ...sum.youOwe].map((p) => {
                  const only = p.groups.length === 1 ? p.groups[0] : null;
                  return (
                    <Link key={p.key} href={only ? `/groups/${only.groupId}?tab=balances` : "/groups"} className="item clickable">
                      <Avatar name={p.name} color={p.color} src={p.avatar} size={36} />
                      <div className="item-main">
                        <div className="item-title">{p.name}</div>
                        <div className="item-sub wrap2">{p.groups.map((g) => g.groupName).join(" · ")}</div>
                      </div>
                      <div className="item-end">
                        <div className={`v ${p.amount > 0 ? "pos" : "neg"}`} style={{ fontWeight: 700 }}>
                          {p.amount > 0 ? <ArrowDownLeft width={13} height={13} style={{ verticalAlign: -2 }} /> : <ArrowUpRight width={13} height={13} style={{ verticalAlign: -2 }} />} {money(Math.abs(p.amount), p.currency)}
                        </div>
                        <div className="k">{p.amount > 0 ? "owes you" : "you owe"}</div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}

          <Card title="Recent activity" action={<Link href="/activity" className="btn btn-ghost btn-sm">See all</Link>}>
            <ActivityList items={data.activity.slice(0, 8)} groups={data.groups} compact />
          </Card>
        </div>
      </div>
    </main>
  );
}
