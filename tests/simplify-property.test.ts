// Property tests for simplifyDebts over seeded random groups (same seed on every run, so CI is deterministic).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { netBalances, pairwiseDebts, simplifyDebts, simplifyDebtsInfo, type Tx } from "../src/lib/debts.ts";
import { fewestPayments, randomGroup, randomGroups, rng, type Group } from "./random-ledger.ts";

// Two populations, about 0.5 s of CPU together. Larger groups are slow to search exactly, so they live in
// `npm run bench:simplify`.
// - random: 300 groups of 2-7 people with 1-25 expenses. Their balances almost never split into zero-sum
//   parts, so the fewest payments is n-1 and plain greedy reaches it too.
// - circles: 300 groups of 4-8 people whose expenses stay inside 2 to n/2 circles. Each circle settles on
//   its own, so the fewest payments is often below n-1, and greedy misses it in some groups. These are
//   the groups where the exact search matters.
const SEED = 20261022;
const CIRCLE_SEED = 20261023;
const run = (gs: Group[]) => gs.map((g) => {
  const net = netBalances(g.ids, g.entries);
  const raw = pairwiseDebts(g.entries);
  return { net, raw, ...simplifyDebtsInfo(net, raw) };
});
const groups = run(randomGroups(SEED, 300, 2, 7, 1, 25));
const circles = run(randomGroups(CIRCLE_SEED, 300, 4, 8, 1, 25, true));
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

for (const [label, set] of [["random", groups], ["circle", circles]] as const) {
  test(`simplify settles every ${label} group exactly, with no relays, in the fewest possible payments`, () => {
    for (const [i, { net, tx, fallback }] of set.entries()) {
      const people = Object.values(net).filter((v) => v !== 0).length;
      const ctx = `${label} group ${i}: ${JSON.stringify(net)} -> ${JSON.stringify(tx)}`;
      assert.ok(Object.values(settle(net, tx)).every((v) => v === 0), `every balance settles; ${ctx}`);
      for (const t of tx) {
        assert.ok(Number.isSafeInteger(t.amount) && t.amount > 0, `whole positive cents; ${ctx}`);
        assert.ok(net[t.from] < 0 && net[t.to] > 0, `no relays: only people who owe pay, only people owed receive; ${ctx}`);
      }
      assert.ok(tx.length <= Math.max(0, people - 1), `at most n-1 payments; ${ctx}`);
      // The search is exact unless it ran out of combinations; at these sizes it never does.
      assert.equal(fallback, null, `exact search finished; ${ctx}`);
      assert.equal(tx.length, fewestPayments(Object.values(net)), `fewest payments (exact subset-DP bound); ${ctx}`);
    }
  });
}

test("the circle groups need the exact search: greedy alone uses more payments in some of them", (t) => {
  const worse = circles.filter(({ net, raw, tx }) => simplifyDebtsInfo(net, raw, { budget: 0 }).tx.length > tx.length).length;
  const belowN1 = circles.filter(({ net, tx }) => tx.length < Object.values(net).filter((v) => v !== 0).length - 1).length;
  t.diagnostic(`circle groups below n-1 payments: ${belowN1}/${circles.length}; greedy uses more payments: ${worse}/${circles.length}`);
  // If these hit 0, the fewest-payments check above would pass with greedy alone and prove nothing.
  assert.ok(belowN1 > 0 && worse > 0, `below n-1: ${belowN1}, greedy worse: ${worse}`);
});

test("the memoized simplifyDebts returns the exact search's payments, as fresh copies", () => {
  for (const { net, raw, tx } of [...groups, ...circles]) {
    assert.deepEqual(simplifyDebts(net, raw), tx);
    const again = simplifyDebts(net, raw);
    assert.deepEqual(again, tx, "a memo hit returns the same payments");
    for (const t of again) t.amount = -1;
    assert.deepEqual(simplifyDebts(net, raw), tx, "editing a returned list does not touch the memo");
  }
});

test("past the combination budget, simplify falls back to greedy, which still settles everyone", () => {
  const g = randomGroup(rng(9), 9, 30);
  const net = netBalances(g.ids, g.entries);
  const raw = pairwiseDebts(g.entries);
  const budget = simplifyDebtsInfo(net, raw, { budget: 0 });
  assert.equal(budget.fallback, "budget");
  const people = Object.values(net).filter((v) => v !== 0).length;
  assert.ok(budget.tx.length <= people - 1);
  assert.ok(Object.values(settle(net, budget.tx)).every((v) => v === 0));
  for (const t of budget.tx) assert.ok(net[t.from] < 0 && net[t.to] > 0);
  assert.equal(simplifyDebtsInfo({}, []).fallback, null, "nothing to settle is exact");
});

test("simplify ignores the clock, so a slow device suggests the same payments as a fast one", () => {
  // 8 people, 20 expenses: the exact search tries 792 route sets, and its answer differs from greedy's.
  // A clock that jumps 1 s per read stands in for a very slow phone. A wall-clock cap (2530b66) gave up
  // after 256 combinations here and returned the greedy answer instead.
  const g = randomGroup(rng(1), 8, 20);
  const net = netBalances(g.ids, g.entries);
  const raw = pairwiseDebts(g.entries);
  const fast = simplifyDebtsInfo(net, raw);
  assert.notDeepEqual(fast.tx, simplifyDebtsInfo(net, raw, { budget: 0 }).tx, "this group must tell the exact search from greedy");
  const real = performance.now;
  let clock = 0;
  performance.now = () => (clock += 1000);
  try {
    assert.deepEqual(simplifyDebtsInfo(net, raw), fast);
    assert.deepEqual(simplifyDebts({ ...net }, raw.map((t) => ({ ...t }))), fast.tx);
  } finally {
    performance.now = real;
  }
});

test("simplify outputs match the golden file recorded from the code before the memo was added", () => {
  // Both digest lists were computed by src/lib/debts.ts as it was on main (108950d). The memo test above
  // shows simplifyDebts returns these same payments.
  const got = groups.map((g) => digest(g.tx));
  const gotCircles = circles.map((g) => digest(g.tx));
  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
    const circleEntry = { seed: CIRCLE_SEED, groups: circles.length, digests: gotCircles };
    fs.writeFileSync(GOLDEN, JSON.stringify({ seed: SEED, groups: groups.length, digests: got, circles: circleEntry }, null, 1) + "\n");
  }
  const want = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as { seed: number; digests: string[]; circles: { seed: number; digests: string[] } };
  assert.equal(want.seed, SEED);
  assert.equal(want.circles.seed, CIRCLE_SEED);
  const changed = (a: string[], b: string[]) => a.map((d, i) => (d === b[i] ? -1 : i)).filter((i) => i >= 0);
  assert.equal(want.digests.length, got.length);
  assert.equal(want.circles.digests.length, gotCircles.length);
  assert.deepEqual(changed(got, want.digests), [], "random groups whose payments changed");
  assert.deepEqual(changed(gotCircles, want.circles.digests), [], "circle groups whose payments changed");
});
