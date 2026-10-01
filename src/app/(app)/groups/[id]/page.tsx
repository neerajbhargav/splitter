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
import { UpcomingBills } from "@/components/UpcomingBills";
import { BigMoney } from "@/components/kit";
import { CHART_COLORS, Donut, MonthlyBars, NetBars } from "@/components/charts";
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
      { table: "upcoming_bills", filter: `group_id=eq.${id}` },
    ],
    reload,
  );
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const e = q.get("e");
    if (e) setDetailId(e);
    const t = q.get("tab");
    if (t === "balances" || t === "activity" || t === "insights" || t === "expenses") setTab(t);
  }, []);

  const d = useMemo(() => {
    if (!b) return null;
    const ids = b.members.map((m) => m.id);
    const live = b.expenses.filter((e) => !e.deleted_at);
    const net = netBalances(ids, live);
    const raw = pairwiseDebts(live);
    const simple = simplifyDebts(net, raw);
    return {
      live,
      net,
      simple,
      raw,
      debts: b.group.simplify_debts ? simple : raw,
      mine: b.members.find((m) => m.user_id === me.id),
      totals: paidAndShare(live),
      spent: live.filter((e) => !e.is_payment).reduce((a, e) => a + e.amount_cents, 0),
      spentMonth: (() => {
        const n = new Date(); const k = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
        return live.filter((e) => !e.is_payment && e.expense_date.startsWith(k)).reduce((a, e) => a + e.amount_cents, 0);
      })(),
      flows: (() => {
        const f: Record<string, { sent: number; received: number }> = {};
        for (const e of live) {
          if (!e.is_payment) continue;
          for (const p of e.expense_payers) (f[p.member_id] ??= { sent: 0, received: 0 }).sent += p.amount_cents;
          for (const x of e.expense_splits) (f[x.member_id] ??= { sent: 0, received: 0 }).received += x.amount_cents;
        }
        return f;
      })(),
      deleted: new Set(b.expenses.filter((e) => e.deleted_at).map((e) => e.id)),
      upcomingDue: (() => {
        const u: Record<string, { due: number; paid: number }> = {};
        for (const bill of b.upcoming) for (const s of bill.upcoming_bill_shares) {
          const x = (u[s.member_id] ??= { due: 0, paid: 0 });
          if (s.paid_at) x.paid += s.amount_cents; else x.due += s.amount_cents;
        }
        return u;
      })(),
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
      <div className="group-top">
        <Link href="/groups" className="back"><ChevronLeft width={14} /> Groups</Link>
        <div className="icon-cluster">
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setInviteOpen(true)} title="Invite people" aria-label="Invite people"><Link2 /></button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={exportCsv} title="Export CSV" aria-label="Export CSV"><Download /></button>
          <Link href={`/groups/${group.id}/settings`} className="btn btn-ghost btn-icon btn-sm" title="Group settings" aria-label="Group settings"><Settings /></Link>
        </div>
      </div>
      <section className="card group-hero" style={{ overflow: "visible" }}>
        <div style={{ position: "relative" }}><div className="cover" /><span className="cover-icon"><K /></span></div>
        <div className="cover-body">
          <div className="between" style={{ alignItems: "flex-start", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <h1 className="page-title">{group.name}</h1>
              <div className="summary-lines">
                {d.mine && d.debts.filter((t) => t.from === d.mine!.id || t.to === d.mine!.id).slice(0, 3).map((t) => t.from === d.mine!.id
                  ? <span key={t.from + t.to}>You owe {name(t.to)} <b className="neg num">{money(t.amount, cur)}</b></span>
                  : <span key={t.from + t.to}>{name(t.from)} owes you <b className="pos num">{money(t.amount, cur)}</b></span>)}
                {(!d.mine || !d.debts.some((t) => t.from === d.mine!.id || t.to === d.mine!.id)) && <span>You are all settled up in this group</span>}
              </div>
            </div>
            <div style={{ textAlign: "right", flex: "none" }} className="hide-mobile">
              <div className="tiny faint">{myNet > 0 ? "you get back" : myNet < 0 ? "you owe" : "balance"}</div>
              <div className={`xd-amount ${myNet > 0 ? "pos" : myNet < 0 ? "neg" : ""}`} style={{ fontSize: 34, marginTop: 6 }}><BigMoney cents={myNet} currency={cur} /></div>
            </div>
          </div>
          <div className="row-flex small faint wrap" style={{ gap: 8, marginTop: 10 }}>
            <span className="avatar-stack">
              {active.slice(0, 6).map((m) => <Avatar key={m.id} name={m.display_name} color={m.color} src={avatarFor(m, b.profiles)} size={22} />)}
              {active.length > 6 && <span className="avatar" style={{ ["--size" as string]: "22px", background: "var(--surface-3)", color: "var(--ink-2)" }}>+{active.length - 6}</span>}
            </span>
            <span>{groupKind(group.kind).label} · {cur} · spent {money(d.spent, cur)} · this month {money(d.spentMonth, cur)}</span>
          </div>
          <div className="chip-row">
            <button type="button" className="btn btn-primary" onClick={() => setSettle({ open: true, preset: null, payment: null })}><CircleDollarSign /> Settle up</button>
            <button type="button" className="btn hide-mobile" onClick={() => setEditor({ open: true, expense: null })}><Plus /> Add expense</button>
            {(["expenses", "balances", "insights", "activity"] as Tab[]).map((t) => (
              <button key={t} type="button" className={`btn ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
                {t === "insights" ? "Charts" : t === "expenses" ? "Expenses" : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
            <button type="button" className="btn" onClick={() => setInviteOpen(true)}><Link2 /> Invite</button>
          </div>
        </div>
      </section>

      <div style={{ marginTop: 18 }}>
        <UpcomingBills group={group} members={members} bills={b.upcoming} />
      </div>

      <div style={{ height: 18 }} />

      {tab === "expenses" && (
        <ExpensesTab bundle={b} mine={d.mine} name={name} onOpen={(e) => setDetailId(e.id)} onAdd={() => setEditor({ open: true, expense: null })} />
      )}

      {tab === "balances" && (
        <div className="grid-2">
          <section className="card">
            <div className="card-head"><div><div className="card-title">Balances</div><div className="card-desc">Green gets money back, red owes</div></div></div>
            <div className="card-body">
              <NetBars currency={cur} data={members.filter((m) => (d.net[m.id] ?? 0) !== 0).map((m) => ({ name: m.user_id === me.id ? "You" : m.display_name, value: (d.net[m.id] ?? 0) }))
                .sort((x, y) => y.value - x.value)} />
              <div className="list" style={{ marginTop: 6 }}>
                {members.filter((m) => m.is_active || (d.net[m.id] ?? 0) !== 0).map((m) => {
                  const n = d.net[m.id] ?? 0;
                  const t = d.totals[m.id] ?? { paid: 0, share: 0 };
                  return (
                    <div key={m.id} className="item" style={{ alignItems: "flex-start" }}>
                      <Avatar name={m.display_name} color={m.color} src={avatarFor(m, b.profiles)} size={34} />
                      <div className="item-main">
                        <div className="item-title">{m.display_name}{m.user_id === me.id && <span className="faint"> (you)</span>}{!m.is_active && <span className="faint"> (left)</span>}</div>
                        <div className="item-sub wrap2">
                          {[
                            `Paid ${money(t.paid + (d.flows[m.id]?.sent ?? 0), cur)}`,
                            d.flows[m.id]?.received ? `got back ${money(d.flows[m.id].received, cur)}` : null,
                            `share ${money(t.share, cur)}`,
                            !m.user_id ? "not joined yet" : null,
                          ].filter(Boolean).join(" · ")}
                        </div>
                        {d.debts.some((t) => t.from === m.id || t.to === m.id) && (
                          <div className="tree">
                            {d.debts.filter((t) => t.from === m.id).map((t) => (
                              <div key={"o" + t.to}>{m.user_id === me.id ? "You pay" : "Pays"} {name(t.to) === "You" ? "you" : name(t.to)} <b className="neg num">{money(t.amount, cur)}</b></div>
                            ))}
                            {d.debts.filter((t) => t.to === m.id).map((t) => (
                              <div key={"i" + t.from}>{m.user_id === me.id ? "You get" : "Gets"} <b className="pos num">{money(t.amount, cur)}</b> from {name(t.from) === "You" ? "you" : name(t.from)}</div>
                            ))}
                          </div>
                        )}
                        {(d.upcomingDue[m.id]?.due || d.upcomingDue[m.id]?.paid) ? (
                          <div className="item-sub" style={{ marginTop: 2 }}>
                            {d.upcomingDue[m.id].due > 0
                              ? <span className="gold">+ {money(d.upcomingDue[m.id].due, cur)} upcoming, not paid yet</span>
                              : <span className="pos">Upcoming bills paid ✓</span>}
                          </div>
                        ) : null}
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
                <div>
                  {d.debts.map((t) => {
                    const from = members.find((m) => m.id === t.from)!;
                    const to = members.find((m) => m.id === t.to)!;
                    const remind = from.user_id !== me.id ? reminderLink(from, to.user_id === me.id ? "me" : to.display_name, t.amount, group, window.location.origin) : null;
                    return (
                      <div key={t.from + t.to} className="settle-row">
                        <Avatar name={from.display_name} color={from.color} src={avatarFor(from, b.profiles)} size={32} />
                        <span className="arrow-pill"><ChevronLeft width={14} style={{ transform: "rotate(180deg)" }} /></span>
                        <span className="to-avatar"><Avatar name={to.display_name} color={to.color} src={avatarFor(to, b.profiles)} size={32} /></span>
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="clamp-2 small"><b style={{ fontWeight: 600 }}>{name(t.from)}</b> <span className="faint">{from.user_id === me.id ? "pay" : "pays"}</span> <b style={{ fontWeight: 600 }}>{name(t.to)}</b></div>
                          <div className={`amt ${to.user_id === me.id ? "pos" : from.user_id === me.id ? "neg" : ""}`}>{money(t.amount, cur)}</div>
                        </div>
                        {remind && (
                          remind.href ? (
                            <a className="btn btn-ghost btn-icon btn-sm" href={remind.href} title={`Remind ${from.display_name}`} aria-label={`Remind ${from.display_name}`}><Bell /></a>
                          ) : (
                            <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Copy a reminder" aria-label="Copy a reminder"
                              onClick={() => navigator.clipboard.writeText(remind.text).then(() => toast.ok("Reminder copied. Paste it anywhere."))}><Bell /></button>
                          )
                        )}
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setSettle({ open: true, preset: t, payment: null })}>Settle</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="hint" style={{ margin: "8px 0 0" }}>
                {group.simplify_debts
                  ? "Simplify uses the fewest payments, keeps everyone paying people they already owe whenever possible, and never changes anyone's total."
                  : "Each person pays back whoever covered their share of each expense."}
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
        allExpenses={b.expenses}
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
            <div className="item-sub wrap2">Payment{e.notes ? ` · ${e.notes}` : ""}</div>
          </>
        ) : (
          <>
            <div className="item-title row-flex" style={{ gap: 6 }}>
              <span className="clamp-2">{e.description}</span>
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
  const me = useMe();
  const cur = bundle.group.currency;
  const mine = bundle.members.find((m) => m.user_id === me.id);
  const spend = bundle.expenses.filter((e) => !e.deleted_at && !e.is_payment);
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => {
    const dt = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    return { key: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`, label: dt.toLocaleDateString("en-US", { month: "short" }), total: 0, mine: 0 };
  });
  for (const e of spend) {
    const m = months.find((x) => e.expense_date.startsWith(x.key));
    if (!m) continue;
    m.total += e.amount_cents;
    m.mine += e.expense_splits.filter((x) => x.member_id === mine?.id).reduce((a, x) => a + x.amount_cents, 0);
  }
  const byCat = new Map<string, number>();
  for (const e of spend) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amount_cents);
  const cats = [...byCat.entries()].sort((x, y) => y[1] - x[1]).map(([k, v], i) => ({ key: k, name: category(k).label, value: v, color: CHART_COLORS[i % CHART_COLORS.length] }));
  const total = spend.reduce((a, e) => a + e.amount_cents, 0);
  const totals = paidAndShare(spend);
  const people = bundle.members.filter((m) => totals[m.id]).map((m) => ({ m, ...totals[m.id] })).sort((x, y) => y.share - x.share);
  const maxP = Math.max(1, ...people.map((p) => Math.max(p.paid, p.share)));

  if (!spend.length) {
    return <section className="card"><div className="card-body"><Empty title="Nothing to chart yet">Insights appear once the group has a few expenses.</Empty></div></section>;
  }
  return (
    <div className="dash-grid">
      <div className="dash-col">
        <section className="card">
          <div className="card-head"><div><div className="card-title">Spending by month</div><div className="card-desc">Group total vs your share, last 6 months</div></div></div>
          <div className="card-body"><MonthlyBars data={months} currency={cur} /></div>
        </section>
        <section className="card">
          <div className="card-head"><div><div className="card-title">Paid vs share</div><div className="card-desc">What each person put in compared with what they used</div></div></div>
          <div className="card-body stack-sm">
            {people.map(({ m, paid, share }) => (
              <div key={m.id}>
                <div className="between small" style={{ marginBottom: 4 }}>
                  <span className="row-flex" style={{ gap: 8 }}><Avatar name={m.display_name} color={m.color} src={avatarFor(m, bundle.profiles)} size={22} /> {m.user_id === me.id ? "You" : m.display_name}</span>
                  <span className="faint num">paid {money(paid, cur)} · share {money(share, cur)}</span>
                </div>
                <div className="progress sm" style={{ marginBottom: 3 }}><span style={{ width: `${(paid / maxP) * 100}%` }} /></div>
                <div className="progress sm"><span style={{ width: `${(share / maxP) * 100}%`, background: "var(--chart-2)" }} /></div>
              </div>
            ))}
            <div className="row-flex small faint" style={{ gap: 16, marginTop: 4 }}>
              <span className="row-flex" style={{ gap: 6 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: "var(--chart-1)", display: "inline-block" }} /> Paid</span>
              <span className="row-flex" style={{ gap: 6 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: "var(--chart-2)", display: "inline-block" }} /> Share</span>
            </div>
          </div>
        </section>
      </div>
      <div className="dash-col">
        <section className="card">
          <div className="card-head"><div><div className="card-title">By category</div><div className="card-desc">All time</div></div></div>
          <div className="card-body"><Donut data={cats} currency={cur} center={money(total, cur)} centerLabel="total spent" /></div>
        </section>
      </div>
    </div>
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
