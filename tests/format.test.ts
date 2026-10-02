import { test } from "node:test";
import assert from "node:assert/strict";
import { centsToInput, money } from "../src/lib/format.ts";
import { parseMoney } from "../src/lib/split.ts";

test("money exposes ledger hundredths for every currency", () => {
  assert.equal(money(12345, "USD"), "$123.45");
  assert.equal(money(12345, "EUR"), "€123.45");
  assert.equal(money(12345, "GBP"), "£123.45");
  assert.equal(money(12345, "INR"), "₹123.45");
  assert.equal(money(12345, "JPY"), "¥123.45");
  assert.equal(money(1, "JPY"), "¥0.01");
  assert.equal(money(0, "JPY"), "¥0.00");
  // Three-decimal ISO currencies also follow this app's hundredths ledger.
  assert.match(money(12345, "KWD"), /123\.45$/);
});

test("money retains sign behavior and caches formats separately", () => {
  assert.equal(money(-1, "JPY"), "-¥0.01");
  assert.equal(money(1, "JPY", { sign: true }), "+¥0.01");
  assert.equal(money(-1, "JPY", { sign: true }), "-¥0.01");
  assert.equal(money(0, "JPY", { sign: true }), "¥0.00");
  assert.equal(money(1, "JPY"), "¥0.01");
  assert.equal(money(-0), "-$0.00");
  assert.equal(money(-0, "USD", { sign: true }), "$0.00");
  assert.equal(money(1, "invalid", { sign: true }), "+$0.01");
});

test("safe integer money stays exact at the ledger maximum", () => {
  assert.equal(money(Number.MAX_SAFE_INTEGER), "$90,071,992,547,409.91");
  assert.equal(money(-Number.MAX_SAFE_INTEGER, "JPY"), "-¥90,071,992,547,409.91");
  assert.equal(money(Number.MAX_SAFE_INTEGER, "EUR", { sign: true }), "+€90,071,992,547,409.91");
});

test("centsToInput formats zeros, negatives and cents without division rounding", () => {
  for (const [cents, text] of [[0, "0.00"], [-0, "0.00"], [1, "0.01"], [-1, "-0.01"],
    [99, "0.99"], [-99, "-0.99"], [100, "1.00"], [-100, "-1.00"], [12345, "123.45"],
    [Number.MAX_SAFE_INTEGER, "90071992547409.91"],
    [-Number.MAX_SAFE_INTEGER, "-90071992547409.91"]] as const) {
    assert.equal(centsToInput(cents), text);
  }
});

test("safe cents round-trip through the exact input parser", () => {
  const values = [0, 1, -1, 100, -100, 99999999999999, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
  for (let delta = 0; delta < 500; delta++) {
    values.push(Number.MAX_SAFE_INTEGER - delta, -Number.MAX_SAFE_INTEGER + delta);
  }
  for (const cents of values) assert.equal(parseMoney(centsToInput(cents)), cents);
});

test("noninteger and nonfinite input behavior stays compatible", () => {
  for (const cents of [0.5, -0.5, 100.25, NaN, Infinity, -Infinity]) {
    assert.equal(centsToInput(cents), (cents / 100).toFixed(2));
  }
});
