"use client";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Paperclip, Trash2 } from "lucide-react";
import { Avatar, Loading, Modal, Segmented } from "./ui";
import { useMe, useToast } from "./providers";
import { api, loadGroup, uploadReceipt } from "@/lib/data";
import { CATEGORIES } from "@/lib/categories";
import { centsToInput, money, todayISO } from "@/lib/format";
import { parseMoney, parseMoneyOrZero, splitByWeights, splitEqual } from "@/lib/split";
import type { Expense, ExpenseInput, Group, Member, RepeatInterval, SplitType } from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved?: (id: string, groupId: string) => void;
  group?: Group;
  members?: Member[];
  groups?: Group[];
  initialGroupId?: string | null;
  expense?: Expense | null;
};

const FORM_ID = "expense-form";

export function ExpenseEditor(props: Props) {
  const { open, onClose, onSaved, expense } = props;
  const toast = useToast();
  const [gid, setGid] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ group: Group; members: Member[] } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && props.group && props.members) setLoaded({ group: props.group, members: props.members });
  }, [open, props.group, props.members]);

  // Pick the starting group only when the modal opens, so live updates don't reset the choice.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current && !props.group) setGid(props.initialGroupId ?? props.groups?.[0]?.id ?? null);
    wasOpen.current = open;
  }, [open, props.group, props.initialGroupId, props.groups]);

  useEffect(() => {
    if (!open || props.group || !gid) return;
    let alive = true;
    setLoaded(null);
    loadGroup(gid)
      .then((b) => alive && b && setLoaded({ group: b.group, members: b.members }))
      .catch((e) => toast.err(e));
    return () => {
      alive = false;
    };
  }, [open, gid, props.group, toast]);

  const pickGroup = !props.group && !expense && (props.groups?.length ?? 0) > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={expense ? "Edit expense" : "Add an expense"}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form={FORM_ID} className="btn btn-primary" disabled={saving || !loaded}>
            {saving ? "Saving..." : expense ? "Save changes" : "Add expense"}
          </button>
        </>
      }
    >
      {pickGroup && (
        <div className="field" style={{ marginBottom: 16 }}>
          <label className="label" htmlFor="exp-group">Group</label>
          <select id="exp-group" className="select" value={gid ?? ""} onChange={(e) => setGid(e.target.value)}>
            {props.groups!.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
      )}
      {!props.group && !gid && <p className="muted">Create a group first, then add expenses to it.</p>}
      {loaded ? (
        <ExpenseForm
          key={loaded.group.id + (expense?.id ?? ":new")}
          group={loaded.group}
          members={loaded.members}
          expense={expense ?? null}
          setSaving={setSaving}
          onDone={(id) => {
            toast.ok(expense ? "Expense updated" : "Expense added");
            onSaved?.(id, loaded.group.id);
            onClose();
          }}
        />
      ) : gid ? (
        <Loading label="Loading group" />
      ) : null}
    </Modal>
  );
}

function ExpenseForm({ group, members, expense, setSaving, onDone }: {
  group: Group; members: Member[]; expense: Expense | null; setSaving: (v: boolean) => void; onDone: (id: string) => void;
}) {
  const me = useMe();
  const involved = (id: string) =>
    !!expense && (expense.expense_payers.some((p) => p.member_id === id) || expense.expense_splits.some((s) => s.member_id === id));
  const people = members.filter((m) => m.is_active || involved(m.id));
  const mine = members.find((m) => m.user_id === me.id);
  const cur = group.currency;

  const [description, setDescription] = useState(expense?.description ?? "");
  const [amount, setAmount] = useState(expense ? centsToInput(expense.amount_cents) : "");
  const [category, setCategory] = useState(expense?.category && expense.category !== "payment" ? expense.category : "general");
  const [date, setDate] = useState(expense?.expense_date ?? todayISO());
  const [notes, setNotes] = useState(expense?.notes ?? "");
  const [repeat, setRepeat] = useState<RepeatInterval>(expense?.repeat_interval ?? "none");
  const [payerMode, setPayerMode] = useState<"single" | "multi">((expense?.expense_payers.length ?? 0) > 1 ? "multi" : "single");
  const [payer, setPayer] = useState<string>(expense?.expense_payers[0]?.member_id ?? mine?.id ?? people[0]?.id ?? "");
  const [payerAmts, setPayerAmts] = useState<Record<string, string>>(() =>
    Object.fromEntries((expense?.expense_payers ?? []).map((p) => [p.member_id, centsToInput(p.amount_cents)])));
  const [splitType, setSplitType] = useState<SplitType>(expense?.split_type ?? "equal");
  const [included, setIncluded] = useState<Set<string>>(() =>
    new Set(expense ? expense.expense_splits.map((s) => s.member_id) : people.filter((m) => m.is_active).map((m) => m.id)));
  const fromSplits = (t: SplitType, f: (s: Expense["expense_splits"][number]) => string) =>
    expense?.split_type === t ? Object.fromEntries(expense.expense_splits.map((s) => [s.member_id, f(s)])) : {};
  const [exact, setExact] = useState<Record<string, string>>(() => fromSplits("exact", (s) => centsToInput(s.amount_cents)));
  const [pct, setPct] = useState<Record<string, string>>(() => fromSplits("percent", (s) => String(s.weight ?? "")));
  const [shares, setShares] = useState<Record<string, string>>(() => fromSplits("shares", (s) => String(s.weight ?? "1")));
  const [file, setFile] = useState<File | null>(null);
  const [dropReceipt, setDropReceipt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = parseMoney(amount) ?? 0;

  const split = useMemo(() => {
    const out = new Map<string, { amount: number; weight: number | null }>();
    let problem: string | null = null;
    let note = "";
    if (splitType === "equal") {
      const ids = people.filter((m) => included.has(m.id)).map((m) => m.id);
      splitEqual(total, ids).forEach((p) => out.set(p.id, { amount: p.amount, weight: null }));
      if (!ids.length) problem = "Pick at least one person to split with";
      else note = total ? `${money(Math.floor(total / ids.length), cur)} each across ${ids.length}` : `Split evenly across ${ids.length}`;
    } else if (splitType === "exact") {
      let sum = 0;
      for (const m of people) {
        const v = parseMoneyOrZero(exact[m.id]);
        sum += v;
        if (v > 0) out.set(m.id, { amount: v, weight: null });
      }
      const left = total - sum;
      if (left !== 0) problem = left > 0 ? `${money(left, cur)} left to assign` : `Over by ${money(-left, cur)}`;
      note = `${money(sum, cur)} of ${money(total, cur)} assigned`;
    } else {
      const src = splitType === "percent" ? pct : shares;
      const weights = people.map((m) => ({ id: m.id, weight: Number(src[m.id] ?? (splitType === "shares" ? 0 : 0)) || 0 }));
      const sum = weights.reduce((a, w) => a + w.weight, 0);
      const negative = weights.some((w) => w.weight < 0);
      splitByWeights(total, weights).forEach((p) => out.set(p.id, { amount: p.amount, weight: weights.find((w) => w.id === p.id)!.weight }));
      if (splitType === "percent") {
        if (negative) problem = "Percentages can't be negative";
        else if (Math.abs(sum - 100) > 0.001) problem = sum < 100 ? `${+(100 - sum).toFixed(2)}% left to assign` : `Over by ${+(sum - 100).toFixed(2)}%`;
        note = `${+sum.toFixed(2)}% of 100%`;
      } else {
        if (negative) problem = "Shares can't be negative";
        else if (sum <= 0) problem = "Give at least one person a share";
        note = `${+sum.toFixed(2)} total shares`;
      }
    }
    return { out, problem, note };
  }, [splitType, people, included, exact, pct, shares, total, cur]);

  const payers = useMemo(() => {
    if (payerMode === "single") {
      return { list: payer ? [{ member_id: payer, amount_cents: total }] : [], problem: payer ? null : "Choose who paid" };
    }
    const list = people.map((m) => ({ member_id: m.id, amount_cents: parseMoneyOrZero(payerAmts[m.id]) })).filter((p) => p.amount_cents > 0);
    const sum = list.reduce((a, p) => a + p.amount_cents, 0);
    const left = total - sum;
    return {
      list,
      sum,
      problem: left === 0 ? null : left > 0 ? `${money(left, cur)} of the payment is unassigned` : `Payers are over by ${money(-left, cur)}`,
    };
  }, [payerMode, payer, payerAmts, people, total, cur]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!description.trim()) return setError("Add a description");
    if (total <= 0) return setError("Enter an amount greater than zero");
    if (payers.problem) return setError(payers.problem);
    if (split.problem) return setError(split.problem);
    setSaving(true);
    try {
      let receipt: string | null | undefined;
      if (file) receipt = await uploadReceipt(group.id, file);
      else if (dropReceipt) receipt = null;
      const input: ExpenseInput = {
        description: description.trim(),
        amount_cents: total,
        category,
        expense_date: date,
        notes,
        split_type: splitType,
        is_payment: false,
        repeat_interval: repeat,
        payers: payers.list,
        splits: [...split.out.entries()].map(([member_id, v]) => ({ member_id, amount_cents: v.amount, weight: v.weight })),
        ...(receipt !== undefined ? { receipt_path: receipt } : {}),
      };
      onDone(await api.saveExpense(expense?.id ?? null, group.id, input));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const toggle = (id: string) =>
    setIncluded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <form id={FORM_ID} onSubmit={submit} className="stack">
      <div className="form-row" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <div className="field">
          <label className="label" htmlFor="exp-desc">Description</label>
          <input id="exp-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Groceries, Wi-Fi, rent..." maxLength={100} autoFocus={!expense} />
        </div>
        <div className="field">
          <label className="label" htmlFor="exp-cat">Category</label>
          <select id="exp-cat" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
      </div>

      <div className="form-row" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <div className="field">
          <label className="label" htmlFor="exp-amt">Amount <span className="faint">{cur}</span></label>
          <div className="input-money">
            <span>{money(0, cur).replace(/[\d.,\s]/g, "") || "$"}</span>
            <input id="exp-amt" className="input input-lg" inputMode="decimal" value={amount}
              onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="exp-date">Date</label>
          <input id="exp-date" type="date" className="input" style={{ height: 56 }} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="exp-payer">Paid by</label>
        <select id="exp-payer" className="select" value={payerMode === "multi" ? "__multi" : payer}
          onChange={(e) => {
            if (e.target.value === "__multi") {
              setPayerMode("multi");
              if (!Object.keys(payerAmts).length && payer && total) setPayerAmts({ [payer]: centsToInput(total) });
            } else {
              setPayerMode("single");
              setPayer(e.target.value);
            }
          }}>
          {people.map((m) => <option key={m.id} value={m.id}>{m.user_id === me.id ? `${m.display_name} (you)` : m.display_name}</option>)}
          <option value="__multi">Multiple people</option>
        </select>
        {payerMode === "multi" && (
          <div className="card" style={{ padding: "4px 14px", marginTop: 6 }}>
            {people.map((m) => (
              <div key={m.id} className="split-row" style={{ gridTemplateColumns: "auto 1fr 120px" }}>
                <Avatar name={m.display_name} color={m.color} size={24} />
                <span className="ellipsis">{m.display_name}</span>
                <input className="input input-sm num" inputMode="decimal" placeholder="0.00" value={payerAmts[m.id] ?? ""}
                  onChange={(e) => setPayerAmts({ ...payerAmts, [m.id]: e.target.value })} aria-label={`${m.display_name} paid`} />
              </div>
            ))}
            <div className="split-total" style={{ marginBottom: 10 }}>
              <span className={payers.problem ? "neg" : "faint"}>{payers.problem ?? "Payers add up"}</span>
              <span className="num">{money(payers.sum ?? 0, cur)} / {money(total, cur)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="field">
        <div className="between wrap">
          <span className="label">Split</span>
          <Segmented<SplitType>
            value={splitType}
            onChange={setSplitType}
            options={[
              { id: "equal", label: "Equally" },
              { id: "exact", label: "Exact" },
              { id: "percent", label: "Percent" },
              { id: "shares", label: "Shares" },
            ]}
          />
        </div>
        <div className="card" style={{ padding: "4px 14px", marginTop: 6 }}>
          {people.map((m) => {
            const share = split.out.get(m.id)?.amount ?? 0;
            const on = splitType === "equal" ? included.has(m.id) : share > 0;
            return (
              <div key={m.id} className={`split-row ${on ? "" : "off"}`}>
                <Avatar name={m.display_name} color={m.color} size={26} />
                <span className="ellipsis">
                  {m.display_name}
                  {m.user_id === me.id && <span className="faint"> (you)</span>}
                </span>
                {splitType === "equal" ? (
                  <label className="check" style={{ justifySelf: "end" }}>
                    <input type="checkbox" checked={included.has(m.id)} onChange={() => toggle(m.id)} aria-label={`Include ${m.display_name}`} />
                  </label>
                ) : (
                  <input
                    className="input input-sm num"
                    inputMode="decimal"
                    placeholder={splitType === "exact" ? "0.00" : splitType === "percent" ? "0 %" : "0"}
                    aria-label={`${m.display_name} ${splitType}`}
                    value={(splitType === "exact" ? exact : splitType === "percent" ? pct : shares)[m.id] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (splitType === "exact") setExact({ ...exact, [m.id]: v });
                      else if (splitType === "percent") setPct({ ...pct, [m.id]: v });
                      else setShares({ ...shares, [m.id]: v });
                    }}
                  />
                )}
                <span className="num">{money(share, cur)}</span>
              </div>
            );
          })}
          <div className="split-total" style={{ marginBottom: 10 }}>
            <span className={split.problem ? "neg" : "faint"}>{split.problem ?? split.note}</span>
            {splitType === "equal" && (
              <span>
                <button type="button" className="link-btn" onClick={() => setIncluded(new Set(people.map((m) => m.id)))}>All</button>
                <span className="faint"> / </span>
                <button type="button" className="link-btn" onClick={() => setIncluded(new Set())}>None</button>
              </span>
            )}
            {splitType === "percent" && (
              <button type="button" className="link-btn" onClick={() => {
                const n = people.length;
                const base = Math.floor((100 / n) * 100) / 100;
                const next: Record<string, string> = {};
                people.forEach((m, i) => (next[m.id] = String(i === n - 1 ? +(100 - base * (n - 1)).toFixed(2) : base)));
                setPct(next);
              }}>Even it out</button>
            )}
            {splitType === "shares" && (
              <button type="button" className="link-btn" onClick={() => setShares(Object.fromEntries(people.map((m) => [m.id, "1"])))}>1 share each</button>
            )}
          </div>
        </div>
      </div>

      <div className="form-row">
        <div className="field">
          <label className="label" htmlFor="exp-repeat">Repeats</label>
          <select id="exp-repeat" className="select" value={repeat} onChange={(e) => setRepeat(e.target.value as RepeatInterval)}>
            <option value="none">Does not repeat</option>
            <option value="weekly">Every week</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Every month</option>
            <option value="yearly">Every year</option>
          </select>
        </div>
        <div className="field">
          <span className="label">Receipt</span>
          {expense?.receipt_path && !dropReceipt && !file ? (
            <div className="row-flex" style={{ height: 40 }}>
              <span className="badge gold"><Paperclip /> Attached</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDropReceipt(true)}><Trash2 /> Remove</button>
            </div>
          ) : (
            <label className="btn btn-block" style={{ justifyContent: "flex-start" }}>
              <Paperclip />
              <span className="ellipsis">{file ? file.name : "Attach a photo"}</span>
              <input type="file" accept="image/*,application/pdf" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          )}
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="exp-notes">Notes</label>
        <textarea id="exp-notes" className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" maxLength={1000} />
      </div>

      {error && <div className="banner neg">{error}</div>}
    </form>
  );
}
