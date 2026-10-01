"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight, Bell, ChevronLeft, CircleDollarSign, Copy, Download, Link2, Plus, Repeat, RefreshCw, Search, Settings, Share2, Sparkles,
} from "lucide-react";
import { useMe, useToast } from "@/components/providers";
import { Avatar, Empty, Loading, Modal, Switch } from "@/components/ui";
import { ExpenseEditor } from "@/components/ExpenseEditor";
import { ExpenseDetail } from "@/components/ExpenseDetail";
import { SettleUpModal } from "@/components/SettleUp";
import { ActivityList } from "@/components/ActivityList";
import { api, loadGroup, useLiveRefresh, type GroupBundle } from "@/lib/data";
import { entryNetFor, netBalances, pairwiseDebts, paidAndShare, simplifyDebts, type Tx } from "@/lib/debts";
import { CATEGORIES, category, groupKind } from "@/lib/categories";
import { money, monthLabel, shortDate } from "@/lib/format";
import { groupCsv, download } from "@/lib/csv";
import { avatarFor } from "@/lib/overview";
import { reminderLink } from "@/lib/remind";
import type { Expense, Member } from "@/lib/types";

type Tab = "expenses" | "balances" | "activity" | "insights";

export default function GroupPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const [b, setB] = useState<GroupBundle | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<Tab>("expenses");
  const [editor, setEditor] = useState<{ open: boolean; expense: Expense | null }>({ open: false, expense: null });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [settle, setSettle] = useState<{ open: boolean; preset: Tx | null; payment: Expense | null }>({ open: false, preset: null, payment: null });
  const [inviteOpen, setInviteOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const x = await loadGroup(id);
      setMissing(!x);
      if (x) setB(x);
    } catch (e) {
      toast.err(e);
    }
  }, [id, toast]);

  useEffect(() => {
    setB(null);
    reload();
  }, [reload]);
  useLiveRefresh(
    `group-${id}`,
    [
      { table: "activity", filter: `group_id=eq.${id}` },
      { table: "groups", filter: `id=eq.${id}` },
      { table: "group_members", filter: `group_id=eq.${id}` },
    ],
    reload,
  );
  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get("e");
    if (e) setDetailId(e);
  }, []);

  const d = useMemo(() => {
    if (!b) return null;
    const ids = b.members.map((m) => m.id);
    const live = b.expenses.filter((e) => !e.deleted_at);
    const net = netBalances(ids, live);
    const simple = simplifyDebts(net);
    const raw = pairwiseDebts(live);
    return {
      live,
      net,
      simple,
      raw,
      debts: b.group.simplify_debts ? simple : raw,
      mine: b.members.find((m) => m.user_id === me.id),
      totals: paidAndShare(live),
      deleted: new Set(b.expenses.filter((e) => e.deleted_at).map((e) => e.id)),
    };
  }, [b, me.id]);

  if (missing) {
    return (
      <main className="page page-narrow">
        <Empty title="Group not found" action={<Link href="/dashboard" className="btn">Back to dashboard</Link>}>
          It may have been deleted, or you are no longer a member.
        </Empty>
      </main>
    );
  }
  if (!b || !d) return <Loading />;

  const { group, members } = b;
  const cur = group.currency;
  const K = groupKind(group.kind).icon;
  const myNet = d.mine ? d.net[d.mine.id] ?? 0 : 0;
  const active = members.filter((m) => m.is_active);
  const detail = b.expenses.find((e) => e.id === detailId) ?? null;
  const name = (mid: string) => {
    const m = members.find((x) => x.id === mid);
    return m ? (m.user_id === me.id ? "You" : m.display_name) : "Former member";
  };

  function exportCsv() {
    download(`${group.name.replace(/[^\w\- ]+/g, "").trim() || "group"}-splitter.csv`, groupCsv(group, members, b!.expenses));
  }

  return (
    <main className="page">
      <Link href="/groups" className="back"><ChevronLeft width={14} /> Groups</Link>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow row-flex"><K width={13} height={13} /> {groupKind(group.kind).label} · {cur}</div>
          <h1 className="page-title ellipsis">{group.name}</h1>
          <div className="row-flex" style={{ marginTop: 10 }}>
            <span className="avatar-stack">
              {active.slice(0, 6).map((m) => <Avatar key={m.id} name={m.display_name} color={m.color} src={avatarFor(m, b.profiles)} size={26} />)}
            </span>
            <span className="small muted">
              {myNet > 0 ? <>You are owed <b className="pos num">{money(myNet, cur)}</b></>
                : myNet < 0 ? <>You owe <b className="neg num">{money(-myNet, cur)}</b></>
                : "You are all settled up"}
            </span>
          </div>
        </div>
        <div className="head-actions">
          <button type="button" className="btn btn-primary" onClick={() => setEditor({ open: true, expense: null })}><Plus /> Add expense</button>
          <button type="button" className="btn" onClick={() => setSettle({ open: true, preset: null, payment: null })}><CircleDollarSign /> Settle up</button>
          <button type="button" className="btn btn-icon" onClick={() => setInviteOpen(true)} title="Invite people" aria-label="Invite people"><Link2 /></button>
          <button type="button" className="btn btn-icon" onClick={exportCsv} title="Export CSV" aria-label="Export CSV"><Download /></button>
          <Link href={`/groups/${group.id}/settings`} className="btn btn-icon" title="Group settings" aria-label="Group settings"><Settings /></Link>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {(["expenses", "balances", "activity", "insights"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "expenses" && (
        <ExpensesTab bundle={b} mine={d.mine} name={name} onOpen={(e) => setDetailId(e.id)} onAdd={() => setEditor({ open: true, expense: null })} />
      )}

      {tab === "balances" && (
        <div className="grid-2">
          <section className="card">
            <div className="card-head"><span className="card-title">Balances</span></div>
            <div className="card-body">
              <div className="list">
                {members.filter((m) => m.is_active || (d.net[m.id] ?? 0) !== 0).map((m) => {
                  const n = d.net[m.id] ?? 0;
                  const t = d.totals[m.id] ?? { paid: 0, share: 0 };
                  return (
                    <div key={m.id} className="item">
                      <Avatar name={m.display_name} color={m.color} src={avatarFor(m, b.profiles)} size={34} />
                      <div className="item-main">
                        <div className="item-title">{m.display_name}{m.user_id === me.id && <span className="faint"> (you)</span>}{!m.is_active && <span className="faint"> (left)</span>}</div>
                        <div className="item-sub">Put in {money(n + t.share, cur)} · share {money(t.share, cur)}{!m.user_id && " · not joined yet"}</div>
                      </div>
                      <div className="item-end">
                        <div className="k">{n > 0 ? "gets back" : n < 0 ? "owes" : "settled up"}</div>
                        {n !== 0 && <div className={`v ${n > 0 ? "pos" : "neg"}`}>{money(Math.abs(n), cur)}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <span className="card-title">Who pays whom</span>
              <span className="row-flex small">
                Simplify
                <Switch
                  on={group.simplify_debts}
                  label="Simplify debts"
                  onChange={(v) => api.updateGroup(group.id, { simplify: v }).catch(toast.err)}
                />
              </span>
            </div>
            <div className="card-body stack-sm">
              {d.simple.length < d.raw.length && (
                <div className="banner">
                  <Sparkles />
                  {group.simplify_debts
                    ? `Simplified ${d.raw.length} payments down to ${d.simple.length}.`
                    : `Turn on simplify to cut ${d.raw.length} payments to ${d.simple.length}.`}
                </div>
              )}
              {!d.debts.length ? (
                <Empty title="All settled">Nobody owes anybody in this group.</Empty>
              ) : (
                <div className="list">
                  {d.debts.map((t) => {
                    const from = members.find((m) => m.id === t.from)!;
                    const to = members.find((m) => m.id === t.to)!;
                    const remind = from.user_id !== me.id ? reminderLink(from, to.user_id === me.id ? "me" : to.display_name, t.amount, group, window.location.origin) : null;
                    return (
                      <div key={t.from + t.to} className="debt">
                        <Avatar name={from.display_name} color={from.color} src={avatarFor(from, b.profiles)} size={28} />
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="ellipsis"><b style={{ fontWeight: 500 }}>{name(t.from)}</b> <span className="faint">{from.user_id === me.id ? "pay" : "pays"}</span> <b style={{ fontWeight: 500 }}>{name(t.to)}</b></div>
                          <div className="num small gold">{money(t.amount, cur)}</div>
                        </div>
                        {remind && (
                          remind.href ? (
                            <a className="btn btn-ghost btn-icon btn-sm" href={remind.href} title={`Remind ${from.display_name}`} aria-label={`Remind ${from.display_name}`}><Bell /></a>
                          ) : (
                            <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Copy a reminder" aria-label="Copy a reminder"
                              onClick={() => navigator.clipboard.writeText(remind.text).then(() => toast.ok("Reminder copied. Paste it anywhere."))}><Bell /></button>
                          )
                        )}
                        <button type="button" className="btn btn-sm" onClick={() => setSettle({ open: true, preset: t, payment: null })}>Settle</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="hint" style={{ margin: "8px 0 0" }}>
                {group.simplify_debts
                  ? "Simplify looks only at overall balances, so people may pay someone they never shared an expense with. Totals stay the same."
                  : "Each person pays back whoever covered their share."}
              </p>
            </div>
          </section>
        </div>
      )}

      {tab === "activity" && (
        <section className="card">
          <div className="card-body">
            <ActivityList
              items={b.activity}
              deletedIds={d.deleted}
              onRestore={(eid) => api.restoreExpense(eid).then(() => toast.ok("Restored")).catch(toast.err)}
              onOpen={(a) => a.expense_id && setDetailId(a.expense_id)}
            />
          </div>
        </section>
      )}

      {tab === "insights" && <Insights bundle={b} />}

      <ExpenseEditor
        open={editor.open}
        onClose={() => setEditor({ open: false, expense: null })}
        group={group}
        members={members}
        expense={editor.expense}
      />
      <ExpenseDetail
        expense={detail}
        group={group}
        members={members}
        onClose={() => {
          setDetailId(null);
          if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
        }}
        onEdit={(e) => {
          setDetailId(null);
          if (e.is_payment) setSettle({ open: true, preset: null, payment: e });
          else setEditor({ open: true, expense: e });
        }}
      />
      <SettleUpModal
        open={settle.open}
        onClose={() => setSettle({ open: false, preset: null, payment: null })}
        group={group}
        members={members}
        debts={d.debts}
        preset={settle.preset}
        payment={settle.payment}
      />
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} groupId={group.id} name={group.name} code={group.invite_code} />
    </main>
  );
}

function ExpensesTab({ bundle, mine, name, onOpen, onAdd }: {
  bundle: GroupBundle; mine: Member | undefined; name: (id: string) => string; onOpen: (e: Expense) => void; onAdd: () => void;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const cur = bundle.group.currency;

  const list = bundle.expenses.filter((e) => {
    if (!showDeleted && e.deleted_at) return false;
    if (cat !== "all" && e.category !== cat) return false;
    if (q && !`${e.description} ${e.notes ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const months: { label: string; items: Expense[] }[] = [];
  for (const e of list) {
    const label = monthLabel(e.expense_date);
    if (months[months.length - 1]?.label !== label) months.push({ label, items: [] });
    months[months.length - 1].items.push(e);
  }

  if (!bundle.expenses.length) {
    return (
      <section className="card">
        <div className="card-body">
          <Empty title="No expenses yet" action={<button type="button" className="btn btn-primary" onClick={onAdd}><Plus /> Add the first one</button>}>
            Add rent, groceries or that pizza night. Everyone in the group sees it instantly.
          </Empty>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-body">
        <div className="row-flex wrap" style={{ marginBottom: 6 }}>
          <div style={{ position: "relative", flex: "1 1 200px" }}>
            <Search width={15} style={{ position: "absolute", left: 11, top: 12, color: "var(--ink-3)" }} />
            <input className="input" style={{ paddingLeft: 34 }} placeholder="Search expenses" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search expenses" />
          </div>
          <select className="select" style={{ width: 170 }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Filter by category">
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            <option value="payment">Payments</option>
          </select>
          <label className="check small muted">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted
          </label>
        </div>
        {!list.length && <p className="hint">No matches.</p>}
        {months.map((m) => (
          <div key={m.label}>
            <div className="month-label">{m.label}</div>
            <div className="list">
              {m.items.map((e) => <ExpenseRow key={e.id} e={e} mine={mine} name={name} cur={cur} onClick={() => onOpen(e)} />)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExpenseRow({ e, mine, name, cur, onClick }: { e: Expense; mine: Member | undefined; name: (id: string) => string; cur: string; onClick: () => void }) {
  const cat = category(e.category);
  const Icon = cat.icon;
  const { mon, day } = shortDate(e.expense_date);
  const net = entryNetFor(e, mine?.id);
  const involved = !!mine && (e.expense_payers.some((p) => p.member_id === mine.id) || e.expense_splits.some((s) => s.member_id === mine.id));
  const payers = e.expense_payers;
  return (
    <div className={`item clickable ${e.deleted_at ? "deleted" : ""}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(k) => k.key === "Enter" && onClick()}>
      <div className="datebox"><div className="m">{mon}</div><div className="d">{day}</div></div>
      <span className={`icon-tile ${e.is_payment ? "gold" : ""}`}><Icon /></span>
      <div className="item-main">
        {e.is_payment ? (
          <>
            <div className="item-title row-flex" style={{ gap: 6 }}>{name(payers[0]?.member_id)} <ArrowRight width={13} className="faint" /> {name(e.expense_splits[0]?.member_id)}</div>
            <div className="item-sub">Payment{e.notes ? ` · ${e.notes}` : ""}</div>
          </>
        ) : (
          <>
            <div className="item-title row-flex" style={{ gap: 6 }}>
              <span className="ellipsis">{e.description}</span>
              {e.repeat_interval !== "none" && <Repeat width={12} className="gold" style={{ flex: "none" }} />}
              {e.receipt_path && <span className="badge" style={{ height: 18 }}>receipt</span>}
            </div>
            <div className="item-sub">
              {payers.length === 1 ? `${name(payers[0].member_id)} paid ${money(payers[0].amount_cents, cur)}` : `${payers.length} people paid ${money(e.amount_cents, cur)}`}
            </div>
          </>
        )}
      </div>
      <div className="item-end">
        {e.is_payment ? (
          <div className="v gold">{money(e.amount_cents, cur)}</div>
        ) : !involved ? (
          <div className="k">not involved</div>
        ) : net === 0 ? (
          <div className="k">even</div>
        ) : (
          <>
            <div className="k">{net > 0 ? "you lent" : "you borrowed"}</div>
            <div className={`v ${net > 0 ? "pos" : "neg"}`}>{money(Math.abs(net), cur)}</div>
          </>
        )}
      </div>
    </div>
  );
}

function Insights({ bundle }: { bundle: GroupBundle }) {
  const cur = bundle.group.currency;
  const spend = bundle.expenses.filter((e) => !e.deleted_at && !e.is_payment);
  const total = spend.reduce((a, e) => a + e.amount_cents, 0);
  const today = new Date();
  const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const monthTotal = spend.filter((e) => e.expense_date.startsWith(thisMonth)).reduce((a, e) => a + e.amount_cents, 0);

  const byCat = new Map<string, number>();
  for (const e of spend) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amount_cents);
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...cats.map((c) => c[1]));

  const months: { key: string; label: string; total: number }[] = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    months.push({ key, label: dt.toLocaleDateString("en-US", { month: "short" }), total: spend.filter((e) => e.expense_date.startsWith(key)).reduce((a, e) => a + e.amount_cents, 0) });
  }
  const maxMonth = Math.max(1, ...months.map((m) => m.total));
  const totals = paidAndShare(spend);

  if (!spend.length) {
    return <section className="card"><div className="card-body"><Empty title="Nothing to chart yet">Insights appear once the group has a few expenses.</Empty></div></section>;
  }

  return (
    <>
      <section className="stats" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="stat"><div className="eyebrow">Total spent</div><div className="stat-value">{money(total, cur)}</div></div>
        <div className="stat" style={{ borderLeft: "1px solid var(--line)" }}><div className="eyebrow">This month</div><div className="stat-value">{money(monthTotal, cur)}</div></div>
      </section>
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><span className="card-title">By category</span></div>
          <div className="card-body">
            {cats.map(([id, amt]) => (
              <div key={id} className="bar-row">
                <span className="ellipsis">{category(id).label}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(amt / maxCat) * 100}%` }} /></div>
                <span className="num">{money(amt, cur)}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><span className="card-title">Last 6 months</span></div>
          <div className="card-body">
            {months.map((m) => (
              <div key={m.key} className="bar-row">
                <span>{m.label}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(m.total / maxMonth) * 100}%`, opacity: m.key === thisMonth ? 1 : 0.6 }} /></div>
                <span className="num">{money(m.total, cur)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><span className="card-title">Per person</span></div>
        <div className="card-body">
          <div className="list">
            {bundle.members.filter((m) => totals[m.id]).map((m) => (
              <div key={m.id} className="item">
                <Avatar name={m.display_name} color={m.color} src={avatarFor(m, bundle.profiles)} size={30} />
                <div className="item-main"><div className="item-title">{m.display_name}</div></div>
                <div className="item-end"><div className="k">paid</div><div className="v">{money(totals[m.id].paid, cur)}</div></div>
                <div className="item-end" style={{ minWidth: 90 }}><div className="k">share</div><div className="v muted">{money(totals[m.id].share, cur)}</div></div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function InviteModal({ open, onClose, groupId, name, code }: { open: boolean; onClose: () => void; groupId: string; name: string; code: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const link = typeof window === "undefined" ? "" : `${window.location.origin}/join/${code}`;
  const canShare = typeof navigator !== "undefined" && "share" in navigator;
  return (
    <Modal open={open} onClose={onClose} title="Invite people">
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Anyone with this link can join <b>{name}</b>. If you already added them by name, they can claim that spot and keep their expenses.
        </p>
        <div className="row-flex">
          <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
          <button type="button" className="btn btn-primary" onClick={() => navigator.clipboard.writeText(link).then(() => toast.ok("Link copied"))}><Copy /> Copy</button>
        </div>
        <div className="row-flex wrap">
          {canShare && (
            <button type="button" className="btn" onClick={() => navigator.share({ title: `Join ${name} on SPLITTER`, url: link }).catch(() => {})}>
              <Share2 /> Share
            </button>
          )}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              await api.regenerateInvite(groupId);
              toast.ok("Old link disabled. New link ready.");
            } catch (e) {
              toast.err(e);
            } finally {
              setBusy(false);
            }
          }}>
            <RefreshCw /> Reset link
          </button>
        </div>
        <p className="hint" style={{ margin: 0 }}>Adding someone's email in group settings also works: they are connected automatically the first time they sign in with it.</p>
      </div>
    </Modal>
  );
}
