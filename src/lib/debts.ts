// Balance and debt math. Pure functions, integer cents, no imports.

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

/** Turn a net map into payments, matching biggest debtor with biggest creditor. */
function settleNet(net: Record<string, number>, exactFirst: boolean): Tx[] {
  const cred: { id: string; amt: number }[] = [];
  const debt: { id: string; amt: number }[] = [];
  for (const id of Object.keys(net)) {
    const n = net[id];
    if (n > 0) cred.push({ id, amt: n });
    else if (n < 0) debt.push({ id, amt: -n });
  }
  const tx: Tx[] = [];
  if (exactFirst) {
    // Exact matches settle two people with a single payment.
    for (const d of debt) {
      const c = cred.find((c) => c.amt > 0 && c.amt === d.amt);
      if (c) {
        tx.push({ from: d.id, to: c.id, amount: d.amt });
        c.amt = 0;
        d.amt = 0;
      }
    }
  }
  const D = debt.filter((d) => d.amt > 0).sort((a, b) => b.amt - a.amt || a.id.localeCompare(b.id));
  const C = cred.filter((c) => c.amt > 0).sort((a, b) => b.amt - a.amt || a.id.localeCompare(b.id));
  let i = 0;
  let j = 0;
  while (i < D.length && j < C.length) {
    const x = Math.min(D[i].amt, C[j].amt);
    if (x > 0) tx.push({ from: D[i].id, to: C[j].id, amount: x });
    D[i].amt -= x;
    C[j].amt -= x;
    if (D[i].amt === 0) i++;
    if (C[j].amt === 0) j++;
  }
  return tx;
}

/**
 * Simplified debts: only overall balances matter, so the group settles
 * in the fewest payments (at most people - 1).
 */
export function simplifyDebts(net: Record<string, number>): Tx[] {
  return settleNet(net, true).sort((a, b) => b.amount - a.amount);
}

/**
 * Unsimplified debts: within each expense, the people who owe pay back the
 * people who paid. Then each pair of people is netted against each other.
 */
export function pairwiseDebts(entries: LedgerEntry[]): Tx[] {
  const owe = new Map<string, number>();
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  for (const e of entries) {
    if (!live(e)) continue;
    const net: Record<string, number> = {};
    for (const p of e.expense_payers) net[p.member_id] = (net[p.member_id] ?? 0) + p.amount_cents;
    for (const s of e.expense_splits) net[s.member_id] = (net[s.member_id] ?? 0) - s.amount_cents;
    for (const t of settleNet(net, false)) owe.set(key(t.from, t.to), (owe.get(key(t.from, t.to)) ?? 0) + t.amount);
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
  return tx.sort((x, y) => y.amount - x.amount);
}

/** Who pays whom for a group, honoring its simplify setting. */
export function groupDebts(memberIds: string[], entries: LedgerEntry[], simplify: boolean): Tx[] {
  return simplify ? simplifyDebts(netBalances(memberIds, entries)) : pairwiseDebts(entries);
}
