"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Users } from "lucide-react";
import { useMe, useToast } from "@/components/providers";
import { useQuickAdd } from "@/components/Shell";
import { Avatar, Empty, Loading } from "@/components/ui";
import { GroupRow } from "@/components/GroupRow";
import { ActivityList } from "@/components/ActivityList";
import { loadOverview, useLiveRefresh, type Overview } from "@/lib/data";
import { summarize, type PersonBalance } from "@/lib/overview";
import { greeting, money } from "@/lib/format";

export default function Dashboard() {
  const me = useMe();
  const toast = useToast();
  const quick = useQuickAdd();
  const [data, setData] = useState<Overview | null>(null);

  const reload = useCallback(() => {
    loadOverview(12).then(setData).catch((e) => toast.err(e));
  }, [toast]);
  useEffect(reload, [reload]);
  useLiveRefresh("dashboard", [{ table: "activity" }, { table: "groups" }, { table: "group_members" }], reload);

  const sum = useMemo(() => (data ? summarize(data, me.id) : null), [data, me.id]);
  if (!data || !sum) return <Loading />;

  const first = (me.profile?.display_name || "").split(" ")[0];

  if (!data.groups.length) {
    return (
      <main className="page page-narrow">
        <div className="eyebrow">{greeting()}{first ? `, ${first}` : ""}</div>
        <h1 className="page-title">Start your first group.</h1>
        <p className="page-sub">
          Make a group for your apartment, a trip, or anyone you share costs with. Add your roommates by name now, and send them
          the invite link whenever you like.
        </p>
        <div className="row-flex wrap" style={{ marginTop: 24 }}>
          <Link href="/groups/new" className="btn btn-primary btn-lg"><Plus /> Create a group</Link>
        </div>
      </main>
    );
  }

  const currencies = Object.keys(sum.totals);
  const primary = currencies.includes(me.profile?.default_currency ?? "") ? me.profile!.default_currency : currencies[0] ?? data.groups[0].currency;
  const t = sum.totals[primary] ?? { owe: 0, owed: 0 };
  const others = currencies.filter((c) => c !== primary);
  const balance = t.owed - t.owe;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{greeting()}{first ? `, ${first}` : ""}</div>
          <h1 className="page-title">Dashboard</h1>
        </div>
        <div className="head-actions">
          <Link href="/groups/new" className="btn"><Users /> New group</Link>
          <button type="button" className="btn btn-primary" onClick={() => quick.open()}><Plus /> Add expense</button>
        </div>
      </div>

      <section className="stats">
        <div className="stat">
          <div className="eyebrow">Total balance</div>
          <div className={`stat-value ${balance > 0 ? "pos" : balance < 0 ? "neg" : ""}`}>
            {balance === 0 ? money(0, primary) : money(balance, primary, { sign: true })}
          </div>
          {others.length > 0 && (
            <div className="tiny faint" style={{ marginTop: 4 }}>
              {others.map((c) => `${money(sum.totals[c].owed - sum.totals[c].owe, c, { sign: true })}`).join(" · ")}
            </div>
          )}
        </div>
        <div className="stat">
          <div className="eyebrow">You owe</div>
          <div className="stat-value neg">{money(t.owe, primary)}</div>
        </div>
        <div className="stat">
          <div className="eyebrow">You are owed</div>
          <div className="stat-value pos">{money(t.owed, primary)}</div>
        </div>
      </section>

      <div className="grid-2">
        <PeopleCard title="You owe" people={sum.youOwe} empty="You don't owe anyone." />
        <PeopleCard title="Owes you" people={sum.owesYou} empty="Nobody owes you right now." />
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <section className="card">
          <div className="card-head">
            <span className="card-title">Groups</span>
            <Link href="/groups/new" className="btn btn-ghost btn-sm"><Plus /> New</Link>
          </div>
          <div className="card-body">
            <div className="list">{sum.groups.map((s) => <GroupRow key={s.group.id} s={s} />)}</div>
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <span className="card-title">Recent activity</span>
            <Link href="/activity" className="btn btn-ghost btn-sm">See all</Link>
          </div>
          <div className="card-body">
            <ActivityList items={data.activity.slice(0, 8)} groups={data.groups} compact />
          </div>
        </section>
      </div>
    </main>
  );
}

function PeopleCard({ title, people, empty }: { title: string; people: PersonBalance[]; empty: string }) {
  return (
    <section className="card">
      <div className="card-head"><span className="card-title">{title}</span></div>
      <div className="card-body">
        {!people.length ? (
          <Empty title="All clear">{empty}</Empty>
        ) : (
          <div className="list">
            {people.map((p) => {
              const only = p.groups.length === 1 ? p.groups[0] : null;
              return (
                <Link key={p.key} href={only ? `/groups/${only.groupId}` : "#"} className="item clickable" onClick={(e) => !only && e.preventDefault()}>
                  <Avatar name={p.name} color={p.color} src={p.avatar} size={34} />
                  <div className="item-main">
                    <div className="item-title">{p.name}</div>
                    <div className="item-sub">
                      {p.groups.map((g) => `${g.groupName} ${money(Math.abs(g.amount), p.currency)}`).join(" · ")}
                    </div>
                  </div>
                  <div className="item-end">
                    <div className="k">{p.amount > 0 ? "owes you" : "you owe"}</div>
                    <div className={`v ${p.amount > 0 ? "pos" : "neg"}`}>{money(Math.abs(p.amount), p.currency)}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
