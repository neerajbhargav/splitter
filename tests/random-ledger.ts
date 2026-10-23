// Seeded random group ledgers for the simplify property test and `npm run bench:simplify`.
// Synthetic only: members are "m0".."m{n-1}", amounts are random cents.
import type { LedgerEntry } from "../src/lib/debts.ts";

/** mulberry32: small, fast, and the same sequence on every machine for a given seed. */
export function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Group = { ids: string[]; entries: LedgerEntry[] };

/**
 * One random group: `n` members and `expenses` expenses. Each expense has one payer (sometimes two),
 * is shared by a random subset of 70% odds per member, and is split equally or by small integer shares.
 * The split is done here, not with src/lib/split.ts, so changes there cannot change these ledgers.
 *
 * With `circles` > 1 the members form that many circles (couples, sub-trips) and each expense stays
 * inside one circle. Each circle's balances then sum to zero, so the group can settle in fewer than
 * n-1 payments, and plain greedy (biggest debtor pays biggest creditor) often misses that.
 * Plain random groups almost never have such zero-sum parts. `circles` = 1 gives the same ledgers
 * as before this option existed.
 */
export function randomGroup(rand: () => number, n: number, expenses: number, circles = 1): Group {
  const ri = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const ids = Array.from({ length: n }, (_, i) => "m" + i);
  // The first `circles` members start one circle each; the rest join one at random.
  const circle = circles === 1 ? [] : ids.map((_, i) => (i < circles ? i : ri(0, circles - 1)));
  const entries: LedgerEntry[] = [];
  for (let e = 0; e < expenses; e++) {
    let pool = ids;
    if (circles > 1) {
      const k = ri(0, circles - 1);
      pool = ids.filter((_, i) => circle[i] === k);
    }
    const total = ri(100, 50_000);
    const among = pool.filter(() => rand() < 0.7);
    if (!among.length) among.push(pool[ri(0, pool.length - 1)]);
    const w = rand() < 0.7 ? among.map(() => 1) : among.map(() => ri(1, 5));
    const sum = w.reduce((x, y) => x + y, 0);
    const parts = among.map((id, i) => ({ id, amount: Math.floor((total * w[i]) / sum) }));
    parts[0].amount += total - parts.reduce((x, p) => x + p.amount, 0);
    const p1 = pool[ri(0, pool.length - 1)];
    const p2 = pool[ri(0, pool.length - 1)];
    const first = p1 !== p2 && rand() < 0.2 ? ri(1, total - 1) : total;
    const payers = first === total ? [{ member_id: p1, amount_cents: total }]
      : [{ member_id: p1, amount_cents: first }, { member_id: p2, amount_cents: total - first }];
    entries.push({ deleted_at: null, expense_payers: payers, expense_splits: parts.map((p) => ({ member_id: p.id, amount_cents: p.amount })) });
  }
  return { ids, entries };
}

/**
 * `count` groups from one seed, with members in [minN, maxN] and expenses in [minE, maxE].
 * `circles` gives each group 2 to n/2 circles (see randomGroup).
 */
export function randomGroups(seed: number, count: number, minN: number, maxN: number, minE: number, maxE: number, circles = false): Group[] {
  const rand = rng(seed);
  const ri = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  return Array.from({ length: count }, () => {
    const n = ri(minN, maxN);
    const e = ri(minE, maxE);
    return randomGroup(rand, n, e, circles ? ri(2, Math.max(2, n >> 1)) : 1);
  });
}

/**
 * The fewest payments that can settle these balances, computed independently of src/lib/debts.ts.
 * Any set of payments splits the people into connected parts, each part's balances sum to zero,
 * and a part of k people needs at least k-1 payments. So the minimum is
 * (people with a balance) - (the most disjoint zero-sum subsets they can be split into).
 * Exact subset DP, O(2^n * n); fine for n <= 16.
 */
export function fewestPayments(balances: number[]): number {
  const v = balances.filter((x) => x !== 0);
  const n = v.length;
  if (n > 16) throw new Error("fewestPayments is exact only for n <= 16");
  const full = (1 << n) - 1;
  const sum = new Float64Array(full + 1);
  const parts = new Int32Array(full + 1);
  for (let m = 1; m <= full; m++) {
    let i = 0;
    while (!(m & (1 << i))) i++;
    sum[m] = sum[m & ~(1 << i)] + v[i];
    let best = 0;
    for (let j = 0; j < n; j++) if (m & (1 << j) && parts[m & ~(1 << j)] > best) best = parts[m & ~(1 << j)];
    parts[m] = best + (sum[m] === 0 ? 1 : 0);
  }
  return n - parts[full];
}
