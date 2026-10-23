// splitByWeights must be the exact largest-remainder split of the weights as typed.
// The oracle checks the three properties that define that split, using BigInt rationals,
// instead of running a second copy of the algorithm:
//   1. the parts sum to the total;
//   2. each part is its exact share rounded down, or rounded down plus one cent;
//   3. a part that got the extra cent has a larger remainder than any part that did not,
//      or the same remainder and an earlier place in the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitByWeights } from "../src/lib/split.ts";
import { rng } from "./random-ledger.ts";

/** Weight as an exact fraction: "33.33" -> 3333n / 100n. Plain decimal strings only (what a person types). */
const frac = (w: number) => {
  const s = String(w);
  assert.match(s, /^\d+(\.\d+)?$/, `test weights are plain decimals, got ${s}`);
  const [i, f = ""] = s.split(".");
  return { num: BigInt(i + f), den: 10n ** BigInt(f.length) };
};

function check(total: number, weights: number[], ctx = "") {
  const ws = weights.map((weight, i) => ({ id: "p" + i, weight }));
  const out = splitByWeights(total, ws);
  const live = ws.filter((w) => w.weight > 0);
  const where = `${ctx} total=${total} weights=${JSON.stringify(weights)} -> ${JSON.stringify(out)}`;
  assert.deepEqual(out.map((p) => p.id), live.map((w) => w.id), `one part per positive weight, in order; ${where}`);
  assert.equal(out.reduce((a, p) => a + p.amount, 0), total, `parts sum to the total; ${where}`);
  // Exact share of person i = total * w_i / sum(w). Put every weight over one denominator D.
  const fs = live.map((w) => frac(w.weight));
  const D = fs.reduce((a, f) => (a > f.den ? a : f.den), 1n);
  const W = fs.map((f) => f.num * (D / f.den));
  const S = W.reduce((a, w) => a + w, 0n);
  const T = BigInt(total);
  const parts = out.map((p, i) => {
    const floor = (T * W[i]) / S;
    const up = BigInt(p.amount) - floor;
    assert.ok(up === 0n || up === 1n, `part ${p.id} is its exact share rounded down, or plus one cent; ${where}`);
    return { i, up: up === 1n, rem: (T * W[i]) % S };
  });
  const ups = parts.filter((p) => p.up);
  const downs = parts.filter((p) => !p.up);
  for (const u of ups) for (const d of downs) {
    assert.ok(u.rem > d.rem || (u.rem === d.rem && u.i < d.i), `extra cent goes to the larger remainder, ties to the earlier person; ${where}`);
  }
}

test("splitByWeights is the exact largest-remainder split: every 2-person day split up to 31 days and $2, every 3-person one up to 20 days and 30 cents", () => {
  for (let a = 1; a <= 31; a++) for (let b = 1; b <= 31; b++) for (let total = 1; total <= 200; total++) check(total, [a, b], "exhaustive");
  for (let a = 1; a <= 20; a++) for (let b = 1; b <= 20; b++) for (let c = 1; c <= 20; c++) {
    for (let total = 1; total <= 30; total++) check(total, [a, b, c], "exhaustive");
  }
});

test("splitByWeights is exact on 20,000 random percent, share and day splits up to 20 people and $1,000,000", () => {
  const rand = rng(20261022);
  const ri = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  for (let k = 0; k < 20_000; k++) {
    const n = ri(1, 20);
    const kind = k % 5;
    let ws: number[];
    if (kind === 0) {
      // Percentages with 2 decimals that add to 100.
      const cuts = Array.from({ length: n - 1 }, () => ri(0, 10_000)).sort((x, y) => x - y);
      const pts = [0, ...cuts, 10_000];
      ws = pts.slice(1).map((p, i) => (p - pts[i]) / 100);
    } else if (kind === 1) ws = Array.from({ length: n }, () => +(100 / n).toFixed(2)); // "33.33" each
    else if (kind === 2) ws = Array.from({ length: n }, () => ri(0, 100)); // whole shares
    else if (kind === 3) ws = Array.from({ length: n }, () => ri(0, 10_000) / 100); // shares like 1.25
    else ws = Array.from({ length: n }, () => ri(0, 31)); // days
    if (!ws.some((w) => w > 0)) ws[0] = 1;
    check(rand() < 0.5 ? ri(1, 100_000) : ri(1, 100_000_000), ws, `random ${k}`);
  }
});

test("ties go to the earlier person: cases the old float division got wrong", () => {
  // 10 cents by shares 1:1:4 is 1.67 / 1.67 / 6.67. All three remainders tie, so the first two get a cent.
  assert.deepEqual(splitByWeights(10, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 4 }]).map((p) => p.amount), [2, 2, 6]);
  // 3 cents by days 12, 28, 11: the 2nd and 3rd people tie at 33/51 of a cent, so the 2nd gets it.
  assert.deepEqual(splitByWeights(3, [{ id: "a", weight: 12 }, { id: "b", weight: 28 }, { id: "c", weight: 11 }]).map((p) => p.amount), [1, 2, 0]);
  // $597.36 by days: the 1st and 3rd people tie at 76/133; float gave the cent to the 3rd.
  const days = [18, 17, 4, 26, 5, 14, 27, 22];
  const r = splitByWeights(59736, days.map((weight, i) => ({ id: "p" + i, weight })));
  assert.deepEqual([r[0].amount, r[2].amount], [8085, 1796]);
  check(59736, days);
});

test("splitByWeights ignores bad weights and refuses bad totals", () => {
  const w = [{ id: "a", weight: 1 }, { id: "b", weight: Number.NaN }, { id: "c", weight: -2 }, { id: "d", weight: Infinity }, { id: "e", weight: 3 }];
  assert.deepEqual(splitByWeights(400, w), [{ id: "a", amount: 100 }, { id: "e", amount: 300 }]);
  assert.deepEqual(splitByWeights(0, w), []);
  assert.deepEqual(splitByWeights(10.5, w), [], "cents are whole numbers");
  assert.deepEqual(splitByWeights(100, [{ id: "a", weight: 0 }]), []);
  // Tiny and huge weights still split exactly (they print in exponent form).
  assert.deepEqual(splitByWeights(100, [{ id: "a", weight: 1e-7 }, { id: "b", weight: 3e-7 }]).map((p) => p.amount), [25, 75]);
  assert.deepEqual(splitByWeights(100, [{ id: "a", weight: 1e21 }, { id: "b", weight: 1e21 }]).map((p) => p.amount), [50, 50]);
});
