import Link from "next/link";
import { groupKind } from "@/lib/categories";
import { money } from "@/lib/format";
import type { GroupSummary } from "@/lib/overview";

/** Splitwise-style group row: name, your balance, and a tree of who you owe / who owes you. */
export function GroupRow({ s, maxLines = 2 }: { s: GroupSummary; maxLines?: number }) {
  const K = groupKind(s.group.kind).icon;
  const cur = s.group.currency;
  const nameOf = (id: string) => s.members.find((m) => m.id === id)?.display_name ?? "Someone";
  const mineLines = s.mine ? s.debts.filter((t) => t.from === s.mine!.id || t.to === s.mine!.id) : [];
  const shown = mineLines.slice(0, maxLines);
  return (
    <Link href={`/groups/${s.group.id}`} className="grow-row clickable">
      <span className="icon-tile" style={{ width: 44, height: 44, borderRadius: 12 }}><K /></span>
      <div className="item-main">
        <div className="item-title clamp-2" style={{ fontSize: 15 }}>{s.group.name}</div>
        {shown.length > 0 ? (
          <div className="tree">
            {shown.map((t) => t.from === s.mine!.id
              ? <div key={t.from + t.to}>You owe {nameOf(t.to)} <b className="neg num">{money(t.amount, cur)}</b></div>
              : <div key={t.from + t.to}>{nameOf(t.from)} owes you <b className="pos num">{money(t.amount, cur)}</b></div>)}
            {mineLines.length > maxLines && <div className="more">Plus {mineLines.length - maxLines} more balance{mineLines.length - maxLines === 1 ? "" : "s"}</div>}
          </div>
        ) : (
          <div className="item-sub">{s.members.filter((m) => m.is_active).length} people · {cur}</div>
        )}
      </div>
      <div className="item-end">
        {s.myNet === 0 ? (
          <div className="k">settled up</div>
        ) : (
          <>
            <div className={`k ${s.myNet > 0 ? "pos" : "neg"}`}>{s.myNet > 0 ? "you are owed" : "you owe"}</div>
            <div className={`v ${s.myNet > 0 ? "pos" : "neg"}`} style={{ fontSize: 16 }}>{money(Math.abs(s.myNet), cur)}</div>
          </>
        )}
      </div>
    </Link>
  );
}
