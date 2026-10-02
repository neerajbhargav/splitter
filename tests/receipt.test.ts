import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt } from "../src/lib/receipt.ts";

test("extracts merchant, explicitly labeled total and ISO date", () => {
  const result = parseReceipt("WHOLE FOODS MARKET\n123 MAIN ST\n2026-09-30\nSubtotal 21.00\nTax 1.26\nTOTAL $22.26\nCash Tendered 50.00\nChange 27.74");
  assert.equal(result.description, "WHOLE FOODS MARKET");
  assert.equal(result.amount_cents, 2226);
  assert.equal(result.date, "2026-09-30");
  assert.deepEqual(result.warnings, []);
});

test("does not choose subtotal, tax, tip, change, tender or largest number", () => {
  for (const text of ["Coffee 5.00\nSubtotal 5.00\nTax 0.30\nCash Tendered 100.00\nChange 94.70", "Total Tax 100.00", "Total items 500", "Total savings 999.99", "Subtotal 15.00", "TOTAL TENDER 500.00", "TOTAL TIP 5.00"]) {
    assert.equal(parseReceipt(text).amount_cents, undefined, text);
  }
});

test("reads total on next line and handles thousands separators", () => {
  assert.equal(parseReceipt("GRAND TOTAL\nUSD 1,234.56").amount_cents, 123456);
  assert.equal(parseReceipt("Amount Due: £25.10").amount_cents, 2510);
  assert.equal(parseReceipt("Total amount 29").amount_cents, 2900);
  assert.equal(parseReceipt("Total\n2026-09-30").amount_cents, undefined);
});

test("rejects conflicting totals but accepts repeated matching labels", () => {
  const conflicting = parseReceipt("TOTAL 25.00\nGRAND TOTAL 30.00");
  assert.equal(conflicting.amount_cents, undefined);
  assert.ok(conflicting.warnings.some((w) => w.includes("Different totals")));
  assert.equal(parseReceipt("Total 25.00\nAmount due 25.00").amount_cents, 2500);
});

test("ambiguous numeric dates are never guessed", () => {
  for (const date of ["01/02/2026", "9-10-26", "09/30/2026", "30/09/2026"]) {
    const result = parseReceipt(`Store\nDATE ${date}\nTotal 12.00`);
    assert.equal(result.date, undefined);
    assert.ok(result.warnings.some((w) => w.includes("date order")));
  }
});

test("recognizes named month dates and validates leap days", () => {
  assert.equal(parseReceipt("Date September 30, 2026").date, "2026-09-30");
  assert.equal(parseReceipt("DATE 30 Sept. 2026").date, "2026-09-30");
  assert.equal(parseReceipt("Feb 29th, 2024").date, "2024-02-29");
  assert.equal(parseReceipt("2025-02-29").date, undefined);
  assert.equal(parseReceipt("April 31, 2026").date, undefined);
});

test("conflicting dates and malformed amounts remain unset", () => {
  assert.equal(parseReceipt("2026-09-30\n2026-10-01").date, undefined);
  for (const text of ["Total -12.00", "Total 0.00", "Total 12.99%", "Total 1,23.00", "Total 12.00 25.00", "Total 900719925474099100.00"]) {
    assert.equal(parseReceipt(text).amount_cents, undefined, text);
  }
  assert.equal(parseReceipt("").description, undefined);
});
