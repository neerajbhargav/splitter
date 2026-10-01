"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Pencil, Repeat, RotateCcw, Send, Trash2 } from "lucide-react";
import { Avatar, Modal } from "./ui";
import { useMe, useToast } from "./providers";
import { addComment, api, deleteComment, loadComments, receiptUrl, useLiveRefresh } from "@/lib/data";
import { category } from "@/lib/categories";
import { longDate, money, timeAgo } from "@/lib/format";
import type { Comment, Expense, Group, Member } from "@/lib/types";

const REPEAT_LABEL: Record<string, string> = { weekly: "Every week", biweekly: "Every 2 weeks", monthly: "Every month", yearly: "Every year" };

export function ExpenseDetail({ expense, group, members, onClose, onEdit }: {
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
        <div className="row-flex" style={{ gap: 14 }}>
          <span className={`icon-tile ${expense.is_payment ? "gold" : ""}`} style={{ width: 52, height: 52, borderRadius: 14 }}><Icon /></span>
          <div className="grow">
            <div className="serif" style={{ fontSize: 26, lineHeight: 1.15 }}>{title}</div>
            <div className="serif gold" style={{ fontSize: 34, lineHeight: 1.1 }}>{money(expense.amount_cents, cur)}</div>
          </div>
        </div>
        <div className="row-flex wrap small faint">
          <span>{longDate(expense.expense_date)}</span>
          {!expense.is_payment && <span className="badge">{cat.label}</span>}
          {expense.repeat_interval !== "none" && <span className="badge gold"><Repeat /> {REPEAT_LABEL[expense.repeat_interval]}</span>}
          <span>Added by {nm(byUser(expense.created_by))} {timeAgo(expense.created_at)}</span>
          {expense.updated_by && <span>, edited {timeAgo(expense.updated_at)}</span>}
        </div>

        {!expense.is_payment && (
          <div className="card" style={{ padding: "4px 16px" }}>
            {payers.map((p) => {
              const m = member(p.member_id);
              return (
                <div key={"p" + p.member_id} className="item">
                  <Avatar name={m?.display_name ?? "?"} color={m?.color} size={28} />
                  <div className="item-main"><span className="item-title">{nm(m)} paid</span></div>
                  <span className="num">{money(p.amount_cents, cur)}</span>
                </div>
              );
            })}
            {expense.expense_splits.map((s) => {
              const m = member(s.member_id);
              const weight = expense.split_type === "percent" ? `${s.weight}%` : expense.split_type === "shares" ? `${s.weight} share${Number(s.weight) === 1 ? "" : "s"}` : "";
              return (
                <div key={"s" + s.member_id} className="item">
                  <span style={{ width: 28 }} />
                  <div className="item-main">
                    <span className="item-sub">{nm(m)} {m?.user_id === me.id ? "owe" : "owes"} {weight && <span className="faint">({weight})</span>}</span>
                  </div>
                  <span className="num muted">{money(s.amount_cents, cur)}</span>
                </div>
              );
            })}
          </div>
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
          {comments.length === 0 && <p className="hint" style={{ margin: 0 }}>No comments yet.</p>}
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
