import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { groupKind } from "@/lib/categories";
import { money } from "@/lib/format";
import type { GroupSummary } from "@/lib/overview";

export function GroupRow({ s }: { s: GroupSummary }) {
  const K = groupKind(s.group.kind).icon;
  const n = s.members.filter((m) => m.is_active).length;
  return (
    <Link href={`/groups/${s.group.id}`} className="item clickable">
      <span className="icon-tile"><K /></span>
      <div className="item-main">
        <div className="item-title">{s.group.name}</div>
        <div className="item-sub">{n} {n === 1 ? "person" : "people"} · {s.group.currency}</div>
      </div>
      <div className="item-end">
        {s.myNet === 0 ? (
          <div className="k">settled up</div>
        ) : (
          <>
            <div className="k">{s.myNet > 0 ? "you are owed" : "you owe"}</div>
            <div className={`v ${s.myNet > 0 ? "pos" : "neg"}`}>{money(Math.abs(s.myNet), s.group.currency)}</div>
          </>
        )}
      </div>
      <ChevronRight width={16} className="faint" />
    </Link>
  );
}
