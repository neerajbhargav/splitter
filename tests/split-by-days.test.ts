import { test } from "node:test";
import assert from "node:assert/strict";
import { splitByDays } from "../src/lib/split.ts";

// Worked example from the 12 Example St bills: Wi-Fi $134.99 for Sep 12 – Oct 11 (30 days).
// Eli's last day was Sep 18, Fin's first day Sep 19, five others lived there throughout.
// The hand calculation charged Eli $5.25, Fin $17.25 and everyone else $22.50 (one $22.49).
test("a bill is split by the days each person lived there", () => {
  const people = [
    { id: "neeraj" }, { id: "ari" }, { id: "bea" }, { id: "cal" }, { id: "dee" },
    { id: "eli", stay_from: "2025-07-29", stay_to: "2026-09-18" },
    { id: "fin", stay_from: "2026-09-19" },
  ];
  const r = splitByDays(13499, "2026-09-12", "2026-10-11", people);
  const amt = Object.fromEntries(r.map((p) => [p.id, p.amount]));
  const days = Object.fromEntries(r.map((p) => [p.id, p.days]));
  assert.equal(amt.eli, 525);
  assert.equal(amt.fin, 1725);
  assert.equal(days.eli, 7);
  assert.equal(days.fin, 23);
  assert.equal(days.neeraj, 30);
  const others = ["neeraj", "ari", "bea", "cal", "dee"].map((id) => amt[id]).sort();
  assert.deepEqual(others, [2249, 2250, 2250, 2250, 2250]);
  assert.equal(r.reduce((a, p) => a + p.amount, 0), 13499);
});

test("people who were not there during the bill are left out", () => {
  const r = splitByDays(10000, "2026-03-01", "2026-03-31", [
    { id: "here" },
    { id: "left", stay_to: "2026-02-28" },
    { id: "later", stay_from: "2026-04-01" },
  ]);
  assert.deepEqual(r.map((p) => [p.id, p.amount, p.days]), [["here", 10000, 31]]);
});

test("a period that ends before it starts splits nothing", () => {
  assert.deepEqual(splitByDays(1000, "2026-03-31", "2026-03-01", [{ id: "a" }]), []);
});
