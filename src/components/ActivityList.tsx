"use client";
import Link from "next/link";
import { CircleDollarSign, MessageSquare, Pencil, Plus, Repeat, RotateCcw, Settings, Trash2, UserPlus, Users } from "lucide-react";
import { money, timeAgo } from "@/lib/format";
import type { ActivityItem, Group } from "@/lib/types";

function iconFor(kind: string) {
  if (kind.startsWith("payment")) return CircleDollarSign;
  if (kind === "comment") return MessageSquare;
  if (kind === "expense_added") return Plus;
  if (kind === "expense_updated") return Pencil;
  if (kind.endsWith("deleted")) return Trash2;
  if (kind === "expense_restored") return RotateCcw;
  if (kind === "expense_recurring") return Repeat;
  if (kind.startsWith("member")) return UserPlus;
  if (kind === "group_updated") return Settings;
  return Users;
}

export function ActivityList({ items, groups, onOpen, onRestore, deletedIds, compact }: {
  items: ActivityItem[];
  groups?: Group[];
  onOpen?: (a: ActivityItem) => void;
  onRestore?: (expenseId: string) => void;
  deletedIds?: Set<string>;
  compact?: boolean;
}) {
  if (!items.length) return <p className="hint" style={{ margin: "6px 0" }}>Nothing yet. Changes from everyone in your groups show up here live.</p>;
  const gmap = new Map(groups?.map((g) => [g.id, g]) ?? []);
  return (
    <div className="list">
      {items.map((a) => {
        const Icon = iconFor(a.kind);
        const g = gmap.get(a.group_id);
        const cur = g?.currency ?? "USD";
        const canRestore = !!a.expense_id && a.kind.endsWith("deleted") && deletedIds?.has(a.expense_id) && onRestore;
        const content = (
          <>
            <span className={`icon-tile ${a.kind.startsWith("payment") ? "gold" : ""}`} style={compact ? { width: 32, height: 32 } : undefined}><Icon /></span>
            <div className="item-main">
              <div style={{ whiteSpace: "normal", lineHeight: 1.4 }}>{a.summary}</div>
              <div className="item-sub">
                {timeAgo(a.created_at)}
                {g && <> · {g.name}</>}
              </div>
            </div>
            {a.amount_cents != null && <span className="num muted small">{money(a.amount_cents, cur)}</span>}
            {canRestore && (
              <button type="button" className="btn btn-sm" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRestore!(a.expense_id!); }}>
                <RotateCcw /> Restore
              </button>
            )}
          </>
        );
        if (onOpen && a.expense_id) {
          return <div key={a.id} className="item clickable" onClick={() => onOpen(a)}>{content}</div>;
        }
        if (!onOpen && groups) {
          return (
            <Link key={a.id} className="item clickable" href={`/groups/${a.group_id}${a.expense_id ? `?e=${a.expense_id}` : ""}`}>
              {content}
            </Link>
          );
        }
        return <div key={a.id} className="item">{content}</div>;
      })}
    </div>
  );
}
