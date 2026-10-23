// Receipt formats the synthetic eval never prints. eval/receipt-gen.ts draws its 7 total labels and 3 kinds of
// fillable date from the set parseReceipt supports, so its perfect-text rows are a ceiling, not a baseline.
// This checks perfect text in formats outside that set: the parser may leave them blank, but must not fill a
// wrong value. The coverage counts are quoted in README.md and eval/README.md; update them with this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt } from "../src/lib/receipt.ts";

const HEAD = "CORNER MARKET\n12 Elm St\nSpringfield\n";
// Each label opens the total line, followed by 12.34. None is one of the generator's 7.
const LABELS = ["Order Total", "Total Sale", "Sale Total", "Net Total", "Purchase Total", "Ticket Total", "AMOUNT", "BALANCE", "Amount Paid", "Total Paid", "Total Amount", "Total Charged"];
// Each means 2026-10-23 and has one reading. None is ISO, "Oct 23, 2026" or "23 Oct 2026" as the generator prints them.
const DATES = ["23-Oct-2026", "OCT-23-2026", "2026/10/23", "2026.10.23", "23.Oct.2026", "Oct 23 '26", "October 23rd, 2026", "Fri, 23 Oct 2026", "23 OCT 26"];

test("held-out receipt formats: no wrong total or date, and the coverage quoted in the README", (t) => {
  const totals = LABELS.map((l) => [l, parseReceipt(`${HEAD}Subtotal 11.00\nTax 1.34\n${l} 12.34\nVISA ending 4242 12.34`).amount_cents] as const);
  const dates = DATES.map((d) => [d, parseReceipt(`${HEAD}${d}\nTOTAL 1.00`).date] as const);
  for (const [k, v] of [...totals, ...dates]) t.diagnostic(`${k} -> ${v ?? "blank"}`);
  assert.deepEqual(totals.filter(([, v]) => v !== undefined && v !== 1234), [], "wrong totals");
  assert.deepEqual(dates.filter(([, v]) => v !== undefined && v !== "2026-10-23"), [], "wrong dates");
  const filled = (xs: readonly (readonly [string, unknown])[]) => xs.filter(([, v]) => v !== undefined).map(([k]) => k);
  assert.deepEqual(filled(totals), ["Total Paid", "Total Amount"], "total labels filled (2 of 12)");
  assert.deepEqual(filled(dates), ["October 23rd, 2026", "Fri, 23 Oct 2026"], "date formats filled (2 of 9)");
});
