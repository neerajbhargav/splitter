// Balance and debt math. Pure functions, integer cents, no imports.
//
// Simplify follows Splitwise's published behavior:
//   1. Everyone's net balance stays exactly the same (so everyone still pays
//      exactly their share of the expenses they were part of).
//   2. Use as few payments as possible.
//   3. Among the fewest-payment answers, prefer paying people you already owe
//      ("no one owes a person they didn't owe before"), and never make anyone
//      pay out more in total than they owed before.

export type Share = { member_id: string; amount_cents: number };
export type LedgerEntry = {
  id?: string;
  deleted_at?: string | null;
  expense_payers: Share[];
  expense_splits: Share[];
};
export type Tx = { from: string; to: string; amount: number };

const live = (e: LedgerEntry) => !e.deleted_at;

/** Net per member: positive = is owed money, negative = owes money. */
export function netBalances(memberIds: string[], entries: LedgerEntry[]): Record<string, number> {
  const net: Record<string, number> = {};
  for (const id of memberIds) net[id] = 0;
  for (const e of entries) {
    if (!live(e)) continue;
    for (const p of e.expense_payers) net[p.member_id] = (net[p.member_id] ?? 0) + p.amount_cents;
    for (const s of e.expense_splits) net[s.member_id] = (net[s.member_id] ?? 0) - s.amount_cents;
  }
  return net;
}

/** Totals paid and owed (share) per member, ignoring payments if `skipPayments`. */
export function paidAndShare(
  entries: (LedgerEntry & { is_payment?: boolean })[],
  skipPayments = true,
): Record<string, { paid: number; share: number }> {
  const out: Record<string, { paid: number; share: number }> = {};
  const get = (id: string) => (out[id] ??= { paid: 0, share: 0 });
  for (const e of entries) {
    if (!live(e) || (skipPayments && e.is_payment)) continue;
    for (const p of e.expense_payers) get(p.member_id).paid += p.amount_cents;
    for (const s of e.expense_splits) get(s.member_id).share += s.amount_cents;
  }
  return out;
}

/** This member's net for one expense: what they paid minus their share. */
export function entryNetFor(e: LedgerEntry, memberId: string | null | undefined): number {
  if (!memberId) return 0;
  const paid = e.expense_payers.filter((p) => p.member_id === memberId).reduce((a, p) => a + p.amount_cents, 0);
  const owed = e.expense_splits.filter((s) => s.member_id === memberId).reduce((a, s) => a + s.amount_cents, 0);
  return paid - owed;
}

/** Split `total` cents across keys in proportion to weights, exactly (largest remainder). */
function apportion(total: number, weights: [string, number][]): [string, number][] {
  const sum = weights.reduce((a, [, w]) => a + w, 0);
  if (sum <= 0 || total <= 0) return [];
  const out = weights.map(([k, w], i) => {
    const exact = (total * w) / sum;
    return { k, i, exact, v: Math.floor(exact) };
  });
  let rem = total - out.reduce((a, r) => a + r.v, 0);
  const order = [...out].sort((a, b) => b.exact - b.v - (a.exact - a.v) || a.i - b.i);
  for (let j = 0; rem > 0; j = (j + 1) % order.length, rem--) order[j].v += 1;
  return out.map((r) => [r.k, r.v]);
}

/**
 * Unsimplified debts (Splitwise's raw view): within each expense, everyone who
 * owes pays back the people who fronted money, in proportion to how much each
 * fronted. Then each pair of people is netted against each other.
 */
export function pairwiseDebts(entries: LedgerEntry[]): Tx[] {
  const owe = new Map<string, number>();
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  for (const e of entries) {
    if (!live(e)) continue;
    const net: Record<string, number> = {};
    for (const p of e.expense_payers) net[p.member_id] = (net[p.member_id] ?? 0) + p.amount_cents;
    for (const s of e.expense_splits) net[s.member_id] = (net[s.member_id] ?? 0) - s.amount_cents;
    const creditors = Object.entries(net).filter(([, v]) => v > 0);
    for (const [debtor, v] of Object.entries(net)) {
      if (v >= 0) continue;
      for (const [cred, amt] of apportion(-v, creditors)) {
        if (amt > 0) owe.set(key(debtor, cred), (owe.get(key(debtor, cred)) ?? 0) + amt);
      }
    }
  }
  const seen = new Set<string>();
  const tx: Tx[] = [];
  for (const k of owe.keys()) {
    const [a, b] = k.split("\u0000");
    const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const d = (owe.get(key(a, b)) ?? 0) - (owe.get(key(b, a)) ?? 0);
    if (d > 0) tx.push({ from: a, to: b, amount: d });
    else if (d < 0) tx.push({ from: b, to: a, amount: -d });
  }
  return finish(tx);
}

/** Greedy fallback: biggest debtor pays biggest creditor. At most n-1 payments. */
function greedy(net: Record<string, number>): Tx[] {
  const cred: { id: string; amt: number }[] = [];
  const debt: { id: string; amt: number }[] = [];
  for (const id of Object.keys(net).sort()) {
    if (net[id] > 0) cred.push({ id, amt: net[id] });
    else if (net[id] < 0) debt.push({ id, amt: -net[id] });
  }
  const tx: Tx[] = [];
  for (const d of debt) {
    const c = cred.find((c) => c.amt > 0 && c.amt === d.amt);
    if (c) {
      tx.push({ from: d.id, to: c.id, amount: d.amt });
      c.amt = 0;
      d.amt = 0;
    }
  }
  const D = debt.filter((d) => d.amt > 0).sort((a, b) => b.amt - a.amt || a.id.localeCompare(b.id));
  const C = cred.filter((c) => c.amt > 0).sort((a, b) => b.amt - a.amt || a.id.localeCompare(b.id));
  let i = 0;
  let j = 0;
  while (i < D.length && j < C.length) {
    const x = Math.min(D[i].amt, C[j].amt);
    tx.push({ from: D[i].id, to: C[j].id, amount: x });
    D[i].amt -= x;
    C[j].amt -= x;
    if (!D[i].amt) i++;
    if (!C[j].amt) j++;
  }
  return tx;
}

/** Fewest payments possible = people with a balance minus the most zero-sum groups they split into. */
function minPayments(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  if (n > 16) return n - 1;
  const full = (1 << n) - 1;
  const sum = new Array<number>(full + 1).fill(0);
  for (let m = 1; m <= full; m++) {
    const low = m & -m;
    sum[m] = sum[m ^ low] + values[31 - Math.clz32(low)];
  }
  const best = new Array<number>(full + 1).fill(0);
  for (let m = 1; m <= full; m++) {
    let b = 0;
    for (let i = 0; i < n; i++) if (m & (1 << i)) b = Math.max(b, best[m ^ (1 << i)]);
    best[m] = b + (sum[m] === 0 ? 1 : 0);
  }
  return n - best[full];
}

/** Max-flow check: can these payment routes settle every balance? Returns flow per route, or null. */
function route(net: Record<string, number>, edges: [string, string][]): Map<string, number> | null {
  const S = "\u0001S";
  const T = "\u0001T";
  const k = (u: string, v: string) => `${u}\u0000${v}`;
  const cap = new Map<string, number>();
  const adj = new Map<string, Set<string>>();
  const link = (u: string, v: string) => {
    if (!adj.has(u)) adj.set(u, new Set());
    adj.get(u)!.add(v);
  };
  const add = (u: string, v: string, c: number) => {
    cap.set(k(u, v), (cap.get(k(u, v)) ?? 0) + c);
    if (!cap.has(k(v, u))) cap.set(k(v, u), 0);
    link(u, v);
    link(v, u);
  };
  let need = 0;
  for (const [id, v] of Object.entries(net)) {
    if (v < 0) {
      add(S, id, -v);
      need += -v;
    } else if (v > 0) add(id, T, v);
  }
  const BIG = 1e13;
  for (const [a, b] of edges) add(a, b, BIG);
  let flow = 0;
  for (;;) {
    const parent = new Map<string, string | null>([[S, null]]);
    const q: string[] = [S];
    while (q.length && !parent.has(T)) {
      const u = q.shift()!;
      for (const v of adj.get(u) ?? []) {
        if (!parent.has(v) && (cap.get(k(u, v)) ?? 0) > 0) {
          parent.set(v, u);
          q.push(v);
        }
      }
    }
    if (!parent.has(T)) break;
    let f = Infinity;
    for (let v = T; parent.get(v) !== null; v = parent.get(v)!) f = Math.min(f, cap.get(k(parent.get(v)!, v))!);
    for (let v = T; parent.get(v) !== null; v = parent.get(v)!) {
      const u = parent.get(v)!;
      cap.set(k(u, v), cap.get(k(u, v))! - f);
      cap.set(k(v, u), cap.get(k(v, u))! + f);
    }
    flow += f;
  }
  if (flow !== need) return null;
  const out = new Map<string, number>();
  for (const [a, b] of edges) {
    const f = BIG - (cap.get(k(a, b)) ?? BIG);
    if (f > 0) out.set(k(a, b), f);
  }
  return out;
}

function* combinations<T>(arr: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = start; i <= arr.length - (k - acc.length); i++) {
    acc.push(arr[i]);
    yield* combinations(arr, k, i + 1, acc);
    acc.pop();
  }
}

function finish(tx: Tx[]): Tx[] {
  return tx.sort((a, b) => b.amount - a.amount || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/**
 * Simplified debts. `raw` (the unsimplified debts) tells us who already owes whom,
 * so payments stay between people who actually shared expenses whenever that
 * doesn't cost an extra payment.
 */
export function simplifyDebts(net: Record<string, number>, raw: Tx[] = []): Tx[] {
  const ids = Object.keys(net).filter((id) => net[id] !== 0).sort();
  if (!ids.length) return [];
  const fallback = greedy(net);
  const target = minPayments(ids.map((id) => net[id]));

  const rawAmt = new Map(raw.map((t) => [`${t.from}\u0000${t.to}`, t.amount]));
  const outTotal = new Map<string, number>();
  for (const t of raw) outTotal.set(t.from, (outTotal.get(t.from) ?? 0) + t.amount);

  const debtors = ids.filter((id) => net[id] < 0);
  const creditors = ids.filter((id) => net[id] > 0);
  const existing: [string, string][] = raw.filter((t) => t.amount > 0).map((t) => [t.from, t.to]);
  const existingKeys = new Set(existing.map(([a, b]) => `${a}\u0000${b}`));
  const fresh: [string, string][] = [];
  for (const d of debtors) for (const c of creditors) if (!existingKeys.has(`${d}\u0000${c}`)) fresh.push([d, c]);

  const toTx = (flows: Map<string, number>): Tx[] =>
    [...flows].map(([key, amount]) => {
      const [from, to] = key.split("\u0000");
      return { from, to, amount };
    });
  // Nobody pays out more in total than they owed before (or than their balance, if nothing raw).
  const valid = (txs: Tx[]) => {
    // No relays: people who are owed never pay, people who owe never receive.
    for (const t of txs) if ((net[t.from] ?? 0) >= 0 || (net[t.to] ?? 0) <= 0) return false;
    const paid = new Map<string, number>();
    for (const t of txs) paid.set(t.from, (paid.get(t.from) ?? 0) + t.amount);
    for (const [id, p] of paid) if (p > Math.max(outTotal.get(id) ?? 0, -Math.min(0, net[id] ?? 0))) return false;
    return true;
  };
  // Tie-break: stay as close as possible to what people originally owed each other.
  const score = (txs: Tx[]) => txs.reduce((a, t) => a + Math.abs(t.amount - (rawAmt.get(`${t.from}\u0000${t.to}`) ?? 0)), 0);

  let budget = 300_000;
  for (let k = target; k <= fallback.length; k++) {
    for (let newAllowed = 0; newAllowed <= Math.min(k, fresh.length); newAllowed++) {
      const pool = newAllowed === 0 ? existing : existing.concat(fresh);
      if (pool.length < k) continue;
      let best: Tx[] | null = null;
      let bestScore = Infinity;
      for (const combo of combinations(pool, k)) {
        if (--budget < 0) return finish(fallback);
        let nNew = 0;
        for (const [x, y] of combo) if (!existingKeys.has(`${x}\u0000${y}`)) nNew++;
        if (nNew !== newAllowed) continue;
        const flows = route(net, combo);
        if (!flows || flows.size !== k) continue;
        const txs = toTx(flows);
        if (!valid(txs)) continue;
        const s = score(txs);
        if (s < bestScore) {
          best = txs;
          bestScore = s;
        }
      }
      if (best) return finish(best);
    }
  }
  return finish(fallback);
}

/** Who pays whom for a group, honoring its simplify setting. */
export function groupDebts(memberIds: string[], entries: LedgerEntry[], simplify: boolean): Tx[] {
  const live = entries.filter((e) => !e.deleted_at);
  const raw = pairwiseDebts(live);
  return simplify ? simplifyDebts(netBalances(memberIds, live), raw) : raw;
}
