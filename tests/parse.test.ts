import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney, splitByWeights, splitEqual } from "../src/lib/split.ts";

test("parseMoney parses exact cents and rejects junk", () => {
  const ok: [string | number, number][] = [["19.99", 1999], ["$1,234.56", 123456], ["1234.5", 123450], ["12", 1200], [" 0.1 ", 10], [".5", 50], ["0.105", 11], ["0.104", 10], ["-12.30", -1230], ["$ 5", 500], [12.34, 1234], ["1,000,000.01", 100000001]];
  for (const [i, o] of ok) assert.equal(parseMoney(i), o, String(i));
  for (const bad of ["", ".", "-", "1e2", "12abc", "abc12xyz34", "1.2.3", "1,23", "$", "--5"]) assert.equal(parseMoney(bad), null, bad);
});

test("splits always sum to the total", () => {
  for (let total = 1; total < 3000; total += 37) {
    for (let n = 1; n <= 8; n++) {
      const ids = Array.from({ length: n }, (_, i) => "m" + i);
      assert.equal(splitEqual(total, ids).reduce((a, p) => a + p.amount, 0), total);
      const w = ids.map((id, i) => ({ id, weight: (i % 3) + 0.5 }));
      assert.equal(splitByWeights(total, w).reduce((a, p) => a + p.amount, 0), total);
    }
  }
});
