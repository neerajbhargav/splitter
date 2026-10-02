"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useMe, useToast } from "@/components/providers";
import { Empty, Loading } from "@/components/ui";
import { GroupRow } from "@/components/GroupRow";
import { loadOverview, useLiveRefresh, type Overview } from "@/lib/data";
import { summarize } from "@/lib/overview";
import { money } from "@/lib/format";

export default function GroupsPage() {
  const me = useMe();
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const reload = useCallback(() => {
    loadOverview(1).then(setData).catch((e) => toast.err(e));
  }, [toast]);
  useEffect(reload, [reload]);
  useLiveRefresh("groups-index", [{ table: "activity" }, { table: "groups" }, { table: "group_members" }], reload);
  const sum = useMemo(() => (data ? summarize(data, me.id) : null), [data, me.id]);
  if (!sum) return <Loading />;
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{sum.groups.length} {sum.groups.length === 1 ? "group" : "groups"}</div>
          <h1 className="page-title">Groups</h1>
        </div>
        <Link href="/groups/new" className="btn btn-primary"><Plus /> New group</Link>
      </div>
      {(() => {
        const tot = Object.entries(sum.totals)[0];
        if (!tot) return <div className="overall faint">Overall, you are all settled up</div>;
        const [cur, t] = tot; const n = t.owed - t.owe;
        return <div className="overall">Overall, {n >= 0 ? "you are owed" : "you owe"} <span className={n >= 0 ? "pos" : "neg"}>{money(Math.abs(n), cur)}</span></div>;
      })()}
      <section className="card">
        <div className="card-body">
          {sum.groups.length ? (
            <div className="list">{sum.groups.map((s) => <GroupRow key={s.group.id} s={s} />)}</div>
          ) : (
            <Empty title="No groups yet" action={<Link href="/groups/new" className="btn btn-primary">Create one</Link>}>
              Groups hold the shared expenses for a home, a trip or a couple.
            </Empty>
          )}
        </div>
      </section>
    </main>
  );
}
