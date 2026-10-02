"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Pencil, Repeat, RotateCcw, Send, Trash2 } from "lucide-react";
import { Avatar, Modal } from "./ui";
import { useMe, useToast } from "./providers";
import { addComment, api, deleteComment, loadComments, receiptUrl, useLiveRefresh } from "@/lib/data";
import { category, groupKind } from "@/lib/categories";
import { longDate, money, timeAgo } from "@/lib/format";
import type { Comment, Expense, Group, Member } from "@/lib/types";

const REPEAT_LABEL: Record<string, string> = { weekly: "Every week", biweekly: "Every 2 weeks", monthly: "Every month", yearly: "Every year" };

export function ExpenseDetail({ expense, group, members, onClose, onEdit, allExpenses = [] }: {
  allExpenses?: Expense[];
  expense: Expense | null;
  group: Group;
  members: Member[];
  onClose: () => void;
  onEdit: (e: Expense) => void;
}) {
  const me = useMe();
  const toast = useToast();
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const eid = expense?.id ?? null;

  const reload = useCallback(async () => {
    if (!eid) return;
    try {
      setComments(await loadComments(eid));
    } catch (e) {
      toast.err(e);
    }
  }, [eid, toast]);

  useEffect(() => {
    setComments([]);
    setReceipt(null);
    reload();
  }, [reload]);

  useEffect(() => {
    if (expense?.receipt_path) receiptUrl(expense.receipt_path).then(setReceipt);
  }, [expense?.receipt_path]);

  useLiveRefresh(`comments-${eid}`, [{ table: "comments", filter: `expense_id=eq.${eid}` }], reload, !!eid);

  if (!expense) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;

  const member = (id: string | null | undefined) => members.find((m) => m.id === id);
  const byUser = (uid: string | null) => members.find((m) => m.user_id && m.user_id === uid);
  const nm = (m?: Member) => (m ? (m.user_id === me.id ? "You" : m.display_name) : "Former member");
  const cat = category(expense.category);
  const Icon = cat.icon;
  const cur = group.currency;
  const deleted = !!expense.deleted_at;

  async function remove() {
    if (!expense) return;
    try {
      await api.deleteExpense(expense.id);
      toast.ok(`Deleted "${expense.description}"`, { label: "Undo", run: () => api.restoreExpense(expense.id).catch(toast.err) });
      onClose();
    } catch (e) {
      toast.err(e);
    }
  }

  async function restore() {
    if (!expense) return;
    try {
      await api.restoreExpense(expense.id);
      toast.ok("Restored");
      onClose();
    } catch (e) {
      toast.err(e);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || !expense) return;
    setBusy(true);
    try {
      await addComment(expense.id, group.id, me.id, body.trim());
      setBody("");
      await reload();
    } catch (err) {
      toast.err(err);
    } finally {
      setBusy(false);
    }
  }

  const payers = expense.expense_payers;
  const title = expense.is_payment ? `${nm(member(payers[0]?.member_id))} paid ${nm(member(expense.expense_splits[0]?.member_id))}` : expense.description;

  return (
    <Modal
      open={!!expense}
      onClose={onClose}
      title={expense.is_payment ? "Payment" : "Expense"}
      footer={
        deleted ? (
          <button type="button" className="btn btn-primary" onClick={restore}><RotateCcw /> Restore</button>
        ) : (
          <>
            <button type="button" className="btn btn-danger" onClick={remove}><Trash2 /> Delete</button>
            <button type="button" className="btn" onClick={() => onEdit(expense)}><Pencil /> Edit</button>
          </>
        )
      }
    >
      <div className="stack">
        {deleted && <div className="banner neg">This was deleted. Restore it to count it again.</div>}
        <div className="xd-head">
          <span className={`icon-tile ${expense.is_payment ? "gold" : ""}`}><Icon /></span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 500, lineHeight: 1.3 }}>{title}</div>
            <div className="xd-amount">{money(expense.amount_cents, cur)}</div>
            <span className="group-chip">{(() => { const GI = groupKind(group.kind).icon; return <span className="icon-tile"><GI /></span>; })()}{group.name}</span>
          </div>
        </div>
        <div className="small faint" style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: -4 }}>
          <span className="row-flex wrap" style={{ gap: 8 }}>
            {longDate(expense.expense_date)}
            {!expense.is_payment && <span className="badge">{cat.label}</span>}
            {expense.repeat_interval !== "none" && <span className="badge gold"><Repeat /> {REPEAT_LABEL[expense.repeat_interval]}</span>}
          </span>
          <span>Added by {nm(byUser(expense.created_by))} {timeAgo(expense.created_at)}</span>
          {expense.updated_by && <span>Last updated by {nm(byUser(expense.updated_by))} {timeAgo(expense.updated_at)}</span>}
        </div>

        {!expense.is_payment && (
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            {payers.map((p) => {
              const m = member(p.member_id);
              return (
                <div key={"p" + p.member_id} className="row-flex" style={{ gap: 12, marginBottom: 4 }}>
                  <Avatar name={m?.display_name ?? "?"} color={m?.color} size={40} />
                  <span style={{ fontSize: 15 }}><b style={{ fontWeight: 600 }}>{nm(m)}</b> paid <b className="num">{money(p.amount_cents, cur)}</b></span>
                </div>
              );
            })}
            <div className="tree" style={{ marginLeft: 20, gap: 8, paddingTop: 4 }}>
              {expense.expense_splits.filter((x) => x.amount_cents !== 0).map((x) => {
                const m = member(x.member_id);
                const weight = expense.split_type === "percent" ? `${x.weight}%` : expense.split_type === "shares" ? `${x.weight} share${Number(x.weight) === 1 ? "" : "s"}` : "";
                return (
                  <div key={"s" + x.member_id} className="tree-avatar" style={{ fontSize: 14 }}>
                    <Avatar name={m?.display_name ?? "?"} color={m?.color} size={24} />
                    <span>{nm(m)} {m?.user_id === me.id ? "owe" : "owes"} <b className="num">{money(x.amount_cents, cur)}</b> {weight && <span className="faint">({weight})</span>}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!expense.is_payment && (() => {
          const months: { key: string; label: string; cents: number }[] = [];
          const base = new Date(expense.expense_date + "T12:00:00");
          for (let i = 2; i >= 0; i--) {
            const dt = new Date(base.getFullYear(), base.getMonth() - i, 1);
            const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
            const cents = allExpenses.filter((e) => !e.deleted_at && !e.is_payment && e.category === expense.category && e.expense_date.startsWith(key)).reduce((a, e) => a + e.amount_cents, 0);
            months.push({ key, label: dt.toLocaleString("en-US", { month: "short" }), cents });
          }
          const max = Math.max(1, ...months.map((m) => m.cents));
          if (!allExpenses.length || months.every((m) => m.cents === 0)) return null;
          return (
            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>Spending trends for {group.name} :: {cat.label}</div>
              {months.map((m, i) => (
                <div key={m.key} className={`trend-row ${i === 2 ? "cur" : ""}`}>
                  <span className="faint">{m.label}</span>
                  <span className="bar-track"><span className="bar-fill" style={{ width: `${(m.cents / max) * 100}%` }} /></span>
                  <span className="num" style={{ textAlign: "right" }}>{money(m.cents, cur)}</span>
                </div>
              ))}
            </div>
          );
        })()}

        {expense.source_currency && (
          <section className="card" style={{padding:14}}>
            <span className="label">Currency conversion</span>
            <p className="num">{money(expense.source_amount_cents ?? 0, expense.source_currency)} → {money(expense.amount_cents, cur)}</p>
            <p className="hint">1 {expense.source_currency} = {expense.fx_rate} {cur} · Rate dated {expense.fx_date}. Saved rate is fixed, not a live revaluation.</p>
          </section>
        )}
        {!!expense.items?.length && (
          <section className="card" style={{padding:14}}>
            <span className="label">Itemized bill</span>
            {expense.items.map((it,i)=><div key={i} className="between wrap" style={{padding:"10px 0",borderBottom:"1px solid var(--line)"}}>
              <div style={{minWidth:0}}><b>{it.description}</b><div className="hint">{it.member_ids.map(id=>nm(member(id))).join(", ")}</div></div>
              <span className="num">{money(it.amount_cents,cur)}</span>
            </div>)}
            <div className="between" style={{marginTop:12}}><span className="muted">Tax</span><span className="num">{money(expense.tax_cents ?? 0,cur)}</span></div>
            <div className="between"><span className="muted">Tip</span><span className="num">{money(expense.tip_cents ?? 0,cur)}</span></div>
            <p className="hint">Tax and tip are shared in proportion to each person's item subtotal. Odd cents are assigned deterministically.</p>
          </section>
        )}

        {expense.notes && (
          <div className="field">
            <span className="label">Notes</span>
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{expense.notes}</p>
          </div>
        )}
        {expense.receipt_path && (
          <div className="field">
            <span className="label">Receipt</span>
            {receipt ? (
              /\.pdf(\?|$)/i.test(expense.receipt_path) ? (
                <a className="btn" href={receipt} target="_blank" rel="noreferrer">Open PDF</a>
              ) : (
                <a href={receipt} target="_blank" rel="noreferrer"><img className="receipt" src={receipt} alt="Receipt" /></a>
              )
            ) : (
              <div className="skeleton" style={{ height: 120 }} />
            )}
          </div>
        )}

        <div className="field">
          <span className="label">Comments</span>
          {comments.length === 0 && <p className="hint">No comments yet.</p>}
          {comments.map((c) => {
            const m = byUser(c.user_id);
            return (
              <div key={c.id} className="comment">
                <Avatar name={m?.display_name ?? "?"} color={m?.color} size={28} />
                <div className="comment-body">
                  <div className="between small">
                    <b style={{ fontWeight: 600 }}>{nm(m)}</b>
                    <span className="faint tiny row-flex" style={{ gap: 6 }}>
                      {timeAgo(c.created_at)}
                      {c.user_id === me.id && (
                        <button type="button" className="link-btn tiny" onClick={() => deleteComment(c.id).then(reload).catch(toast.err)}>Delete</button>
                      )}
                    </span>
                  </div>
                  <p>{c.body}</p>
                </div>
              </div>
            );
          })}
          <form onSubmit={send} className="row-flex" style={{ marginTop: 6 }}>
            <input className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment" maxLength={1000} />
            <button type="submit" className="btn btn-icon" disabled={busy || !body.trim()} aria-label="Send comment"><Send /></button>
          </form>
        </div>
      </div>
    </Modal>
  );
}
