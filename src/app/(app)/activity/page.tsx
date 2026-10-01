"use client";
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/providers";
import { Loading } from "@/components/ui";
import { ActivityList } from "@/components/ActivityList";
import { loadOverview, useLiveRefresh, type Overview } from "@/lib/data";

export default function ActivityPage() {
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const reload = useCallback(() => {
    loadOverview(150).then(setData).catch((e) => toast.err(e));
  }, [toast]);
  useEffect(reload, [reload]);
  useLiveRefresh("activity-page", [{ table: "activity" }], reload);
  if (!data) return <Loading />;
  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div>
          <div className="eyebrow">Live across all groups</div>
          <h1 className="page-title">Activity</h1>
        </div>
      </div>
      <section className="card">
        <div className="card-body">
          <ActivityList items={data.activity} groups={data.groups} />
        </div>
      </section>
    </main>
  );
}
