import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney, splitEqual, splitByWeights, sumPortions } from "../src/lib/split.ts";
import { netBalances, simplifyDebts, pairwiseDebts, groupDebts, entryNetFor, type LedgerEntry } from "../src/lib/debts.ts";

const exp = (payers: [string, number][], splits: [string, number][], deleted = false): LedgerEntry => ({
  deleted_at: deleted ? "2026-01-01" : null,
  expense_payers: payers.map(([member_id, amount_cents]) => ({ member_id, amount_cents })),
  expense_splits: splits.map(([member_id, amount_cents]) => ({ member_id, amount_cents })),
});
const equal = (payer: string, total: number, among: string[]) =>
  exp([[payer, total]], splitEqual(total, among).map((p) => [p.id, p.amount] as [string, number]));

test("parseMoney", () => {
  assert.equal(parseMoney("12.5"), 1250);
  assert.equal(parseMoney("$1,200.00"), 120000);
  assert.equal(parseMoney("0.1"), 10);
  assert.equal(parseMoney("19.99"), 1999);
  assert.equal(parseMoney(""), null);
  assert.equal(parseMoney("abc"), null);
});

test("splitEqual always sums to total", () => {
  for (const total of [1, 2, 99, 100, 1001, 13275, 2799]) {
    for (let n = 1; n <= 7; n++) {
      const ids = Array.from({ length: n }, (_, i) => "p" + i);
      const parts = splitEqual(total, ids);
      assert.equal(sumPortions(parts), total);
      const max = Math.max(...parts.map((p) => p.amount));
      const min = Math.min(...parts.map((p) => p.amount));
      assert.ok(max - min <= 1);
    }
  }
  assert.deepEqual(splitEqual(1000, ["a", "b", "c"]).map((p) => p.amount), [334, 333, 333]);
});

test("splitByWeights handles percents and shares exactly", () => {
  const pct = splitByWeights(10000, [{ id: "a", weight: 33.33 }, { id: "b", weight: 33.33 }, { id: "c", weight: 33.34 }]);
  assert.equal(sumPortions(pct), 10000);
  const shares = splitByWeights(1000, [{ id: "a", weight: 2 }, { id: "b", weight: 1 }]);
  assert.deepEqual(shares.map((p) => p.amount), [667, 333]);
  const odd = splitByWeights(1, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 1 }]);
  assert.equal(sumPortions(odd), 1);
  assert.deepEqual(splitByWeights(500, [{ id: "a", weight: 0 }]), []);
});

test("net balances sum to zero and ignore deleted expenses", () => {
  const ids = ["n", "s", "a", "j"];
  const entries = [
    equal("n", 18640, ids),
    equal("s", 8000, ids),
    equal("a", 13275, ids),
    equal("j", 5400, ["n", "s", "j"]),
    equal("s", 2799, ids),
    equal("n", 3850, ["n", "a"]),
    equal("n", 99999, ids),
  ];
  entries[6].deleted_at = "2026-09-01";
  const net = netBalances(ids, entries);
  assert.equal(Object.values(net).reduce((a, b) => a + b, 0), 0);
  // Same numbers as the single-file prototype.
  assert.deepEqual(net, { n: 8086, s: -1680, a: 671, j: -7077 });
});

test("simplify produces fewer payments that settle everyone", () => {
  const ids = ["n", "s", "a", "j"];
  const entries = [
    equal("n", 18640, ids),
    equal("s", 8000, ids),
    equal("a", 13275, ids),
    equal("j", 5400, ["n", "s", "j"]),
    equal("s", 2799, ids),
    equal("n", 3850, ["n", "a"]),
  ];
  const raw = pairwiseDebts(entries);
  const simple = simplifyDebts(netBalances(ids, entries), raw);
  assert.equal(raw.length, 6);
  assert.equal(simple.length, 3);
  assert.ok(simple.length <= ids.length - 1);

  // Applying either set of payments must zero every balance.
  for (const txs of [raw, simple]) {
    const after = netBalances(ids, [
      ...entries,
      ...txs.map((t) => exp([[t.from, t.amount]], [[t.to, t.amount]])),
    ]);
    assert.ok(Object.values(after).every((v) => v === 0), JSON.stringify(after));
  }
});

test("exact matches are paired directly", () => {
  const tx = simplifyDebts({ a: -500, b: -300, c: 300, d: 500 });
  assert.equal(tx.length, 2);
  assert.ok(tx.some((t) => t.from === "a" && t.to === "d" && t.amount === 500));
  assert.ok(tx.some((t) => t.from === "b" && t.to === "c" && t.amount === 300));
});

test("multiple payers and pair netting", () => {
  // a and b both paid 50 for a 100 dinner shared by a, b, c.
  const e1 = exp([["a", 5000], ["b", 5000]], [["a", 3334], ["b", 3333], ["c", 3333]]);
  // c paid 30 for a taxi shared by a and c.
  const e2 = exp([["c", 3000]], [["a", 1500], ["c", 1500]]);
  const raw = pairwiseDebts([e1, e2]);
  const after = netBalances(["a", "b", "c"], [e1, e2, ...raw.map((t) => exp([[t.from, t.amount]], [[t.to, t.amount]]))]);
  assert.ok(Object.values(after).every((v) => v === 0));
  assert.equal(entryNetFor(e1, "a"), 1666);
  assert.equal(entryNetFor(e2, "a"), -1500);
  assert.equal(entryNetFor(e2, "zzz"), 0);
});

test("payments cancel debts", () => {
  const e = equal("a", 1000, ["a", "b"]);
  const pay = exp([["b", 500]], [["a", 500]]);
  assert.deepEqual(groupDebts(["a", "b"], [e, pay], true), []);
  assert.deepEqual(groupDebts(["a", "b"], [e, pay], false), []);
  assert.deepEqual(groupDebts(["a", "b"], [e], false), [{ from: "b", to: "a", amount: 500 }]);
});

test("random ledgers always settle to zero", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 200; round++) {
    const ids = Array.from({ length: 2 + Math.floor(rnd() * 6) }, (_, i) => "m" + i);
    const entries: LedgerEntry[] = [];
    for (let k = 0; k < 1 + Math.floor(rnd() * 12); k++) {
      const total = 1 + Math.floor(rnd() * 50000);
      const among = ids.filter(() => rnd() > 0.3);
      if (!among.length) among.push(ids[0]);
      entries.push(equal(ids[Math.floor(rnd() * ids.length)], total, among));
    }
    const net = netBalances(ids, entries);
    const raw = pairwiseDebts(entries);
    const simple = simplifyDebts(net, raw);
    assert.ok(simple.length <= ids.length - 1);
    assert.ok(simple.length <= raw.length);
    for (const txs of [simple, raw]) {
      const after = netBalances(ids, [...entries, ...txs.map((t) => exp([[t.from, t.amount]], [[t.to, t.amount]]))]);
      assert.ok(Object.values(after).every((v) => v === 0));
    }
  }
});

test("Splitwise example: Anna owes Bob, Bob owes Charlie -> Anna pays Charlie", () => {
  const e1 = exp([["b", 2000]], [["a", 2000]]);
  const e2 = exp([["c", 2000]], [["b", 2000]]);
  const raw = pairwiseDebts([e1, e2]);
  assert.equal(raw.length, 2);
  assert.deepEqual(simplifyDebts(netBalances(["a", "b", "c"], [e1, e2]), raw), [{ from: "a", to: "c", amount: 2000 }]);
});

test("prefers paying people you already owe when it costs no extra payment", () => {
  // a and b owe x (x paid for them); c and d owe y. Greedy might cross them; the rule keeps them.
  const e1 = exp([["x", 1000]], [["a", 500], ["b", 500]]);
  const e2 = exp([["y", 1200]], [["c", 600], ["d", 600]]);
  const raw = pairwiseDebts([e1, e2]);
  const s = simplifyDebts(netBalances(["a", "b", "c", "d", "x", "y"], [e1, e2]), raw);
  assert.equal(s.length, 4);
  for (const t of s) assert.ok(raw.some((r) => r.from === t.from && r.to === t.to), JSON.stringify(t));
});

test("multi-payer raw debts are proportional", () => {
  // a paid 75, b paid 25 for a 100 dinner shared by a, b, c, d
  const e = exp([["a", 7500], ["b", 2500]], [["a", 2500], ["b", 2500], ["c", 2500], ["d", 2500]]);
  const raw = pairwiseDebts([e]);
  const c = raw.filter((t) => t.from === "c");
  assert.deepEqual(c.map((t) => [t.to, t.amount]).sort(), [["a", 2500]]);
  const after = netBalances(["a", "b", "c", "d"], [e, ...raw.map((t) => exp([[t.from, t.amount]], [[t.to, t.amount]]))]);
  assert.ok(Object.values(after).every((v) => v === 0));
});
