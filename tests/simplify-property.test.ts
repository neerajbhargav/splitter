// Property tests for simplifyDebts over seeded random groups (same seed on every run, so CI is deterministic).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { netBalances, pairwiseDebts, simplifyDebts, simplifyDebtsInfo, type Tx } from "../src/lib/debts.ts";
import { fewestPayments, randomGroup, randomGroups, rng } from "./random-ledger.ts";

// 300 groups of 2-7 people with 1-25 expenses, about 0.5 s of CPU. Larger groups are slow to search
// exactly, so they live in `npm run bench:simplify` instead. No time cap here, so a slow CI machine
// gets the same answers as a fast one.
const SEED = 20261022;
const groups = randomGroups(SEED, 300, 2, 7, 1, 25).map((g) => {
  const net = netBalances(g.ids, g.entries);
  const raw = pairwiseDebts(g.entries);
  return { net, raw, ...simplifyDebtsInfo(net, raw, { timeCapMs: Infinity }) };
});
const GOLDEN = new URL("./fixtures/simplify-golden.json", import.meta.url);

const settle = (net: Record<string, number>, tx: Tx[]) => {
  const after = { ...net };
  for (const t of tx) {
    after[t.from] += t.amount;
    after[t.to] -= t.amount;
  }
  return after;
};
const digest = (tx: Tx[]) => createHash("sha256").update(JSON.stringify(tx)).digest("hex").slice(0, 16);

test("simplify settles every random group exactly, with no relays, in the fewest possible payments", () => {
  let atMin = 0;
  for (const [i, { net, tx, fallback }] of groups.entries()) {
    const people = Object.values(net).filter((v) => v !== 0).length;
    const ctx = `group ${i}: ${JSON.stringify(net)} -> ${JSON.stringify(tx)}`;
    assert.ok(Object.values(settle(net, tx)).every((v) => v === 0), `every balance settles; ${ctx}`);
    for (const t of tx) {
      assert.ok(Number.isSafeInteger(t.amount) && t.amount > 0, `whole positive cents; ${ctx}`);
      assert.ok(net[t.from] < 0 && net[t.to] > 0, `no relays: only people who owe pay, only people owed receive; ${ctx}`);
    }
    assert.ok(tx.length <= Math.max(0, people - 1), `at most n-1 payments; ${ctx}`);
    // The search is exact unless it ran out of combinations; up to 7 people it never does.
    assert.equal(fallback, null, `exact search finished; ${ctx}`);
    assert.equal(tx.length, fewestPayments(Object.values(net)), `fewest payments (exact subset-DP bound); ${ctx}`);
    atMin++;
  }
  assert.equal(atMin, groups.length);
});

test("the memoized simplifyDebts returns the exact search's payments, as fresh copies", () => {
  for (const { net, raw, tx } of groups) {
    assert.deepEqual(simplifyDebts(net, raw, { timeCapMs: Infinity }), tx);
    const again = simplifyDebts(net, raw, { timeCapMs: Infinity });
    assert.deepEqual(again, tx, "a memo hit returns the same payments");
    for (const t of again) t.amount = -1;
    assert.deepEqual(simplifyDebts(net, raw, { timeCapMs: Infinity }), tx, "editing a returned list does not touch the memo");
  }
});

test("past the time cap or the combination budget, simplify falls back to greedy, which still settles everyone", () => {
  // A 9-person group with many expenses: the exact search needs well over 256 combinations here.
  const g = randomGroup(rng(9), 9, 30);
  const net = netBalances(g.ids, g.entries);
  const raw = pairwiseDebts(g.entries);
  let clock = 0;
  const timed = simplifyDebtsInfo(net, raw, { timeCapMs: 100, now: () => (clock += 1000) });
  assert.equal(timed.fallback, "time");
  assert.equal(timed.tried, 256, "the clock is read every 256 combinations, and the 1st read is already past 100 ms");
  const budget = simplifyDebtsInfo(net, raw, { budget: 0 });
  assert.equal(budget.fallback, "budget");
  assert.deepEqual(timed.tx, budget.tx, "both stops return the same greedy answer");
  const people = Object.values(net).filter((v) => v !== 0).length;
  assert.ok(budget.tx.length <= people - 1);
  assert.ok(Object.values(settle(net, budget.tx)).every((v) => v === 0));
  for (const t of budget.tx) assert.ok(net[t.from] < 0 && net[t.to] > 0);
  assert.equal(simplifyDebtsInfo({}, []).fallback, null, "nothing to settle is exact");
});

test("simplify outputs match the golden file recorded before the memo and time cap were added", () => {
  // The memo test above shows simplifyDebts returns these same payments.
  const got = groups.map((g) => digest(g.tx));
  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify({ seed: SEED, groups: groups.length, digests: got }, null, 1) + "\n");
  }
  const want = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as { seed: number; digests: string[] };
  assert.equal(want.seed, SEED);
  const diff = got.map((d, i) => (d === want.digests[i] ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(diff, [], `groups whose payments changed: ${diff.slice(0, 10).join(", ")}`);
});
