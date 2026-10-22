// Property tests for simplifyDebts over seeded random groups (same seed on every run, so CI is deterministic).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { netBalances, pairwiseDebts, simplifyDebts, type Tx } from "../src/lib/debts.ts";
import { fewestPayments, randomGroups } from "./random-ledger.ts";

// 300 groups of 2-7 people with 1-25 expenses, about 0.5 s of CPU. Larger groups are slow to search
// exactly, so they live in `npm run bench:simplify` instead.
const SEED = 20261022;
const groups = randomGroups(SEED, 300, 2, 7, 1, 25).map((g) => {
  const net = netBalances(g.ids, g.entries);
  return { net, tx: simplifyDebts(net, pairwiseDebts(g.entries)) };
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
  for (const [i, { net, tx }] of groups.entries()) {
    const people = Object.values(net).filter((v) => v !== 0).length;
    const ctx = `group ${i}: ${JSON.stringify(net)} -> ${JSON.stringify(tx)}`;
    assert.ok(Object.values(settle(net, tx)).every((v) => v === 0), `every balance settles; ${ctx}`);
    for (const t of tx) {
      assert.ok(Number.isSafeInteger(t.amount) && t.amount > 0, `whole positive cents; ${ctx}`);
      assert.ok(net[t.from] < 0 && net[t.to] > 0, `no relays: only people who owe pay, only people owed receive; ${ctx}`);
    }
    assert.ok(tx.length <= Math.max(0, people - 1), `at most n-1 payments; ${ctx}`);
    assert.equal(tx.length, fewestPayments(Object.values(net)), `fewest payments (exact subset-DP bound); ${ctx}`);
    atMin++;
  }
  assert.equal(atMin, groups.length);
});

test("simplify outputs match the golden file recorded before the memo and time cap were added", () => {
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
