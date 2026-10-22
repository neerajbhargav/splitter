// CI gate for receipt extraction. tests/fixtures/receipts holds every 8th synthetic receipt from
// `npm run eval:receipts`, with that run's subset scores as the baseline. This test reads them with
// the app's OCR settings and parser, offline (the language data comes from node_modules).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Truth } from "../eval/receipt-gen.ts";
import { guessFrom, ocrWorker, score, wilson } from "../eval/receipt-score.ts";

const dir = new URL("./fixtures/receipts/", import.meta.url);
const manifest: { baseline: { total_precision: number; total_coverage: number }; items: { file: string; truth: Truth }[] } =
  JSON.parse(fs.readFileSync(new URL("manifest.json", dir), "utf8"));

test("receipt OCR total precision does not drop below the recorded baseline", async () => {
  const worker = await ocrWorker();
  try {
    const rows = [];
    for (const item of manifest.items) {
      const { data } = await worker.recognize(fs.readFileSync(new URL(item.file, dir)));
      rows.push({ truth: item.truth, guess: guessFrom(data.text) });
    }
    const { total } = score(rows);
    const { total_precision, total_coverage } = manifest.baseline;
    assert.ok(total.precision !== null && total.precision >= total_precision, `total precision ${total.correct}/${total.answered} is below the baseline ${total_precision}`);
    // Refusing every total would keep precision perfect, so coverage may not drop either.
    assert.ok(total.coverage !== null && total.coverage >= total_coverage, `total coverage ${total.answered}/${total.n} is below the baseline ${total_coverage}`);
  } finally {
    await worker.terminate();
  }
});

test("scoring counts wrong answers, refusals and coverage as documented", () => {
  const truth = (t: Partial<Truth>): Truth => ({ merchant: "Blue Heron Market", date: "2026-03-04", date_kind: "iso", date_expect: "extract", subtotal_cents: 1000, tax_cents: 80, total_cents: 1080, ...t });
  const s = score([
    { truth: truth({}), guess: { merchant: "BLUE  HERON MARKET", date: "2026-03-04", total_cents: 1080 } },
    { truth: truth({}), guess: { merchant: ". Blue Heron Market o", total_cents: 1008 } },
    { truth: truth({ date: null, date_kind: "numeric_ambiguous", date_expect: "refuse" }), guess: { date: "2026-03-04" } },
    { truth: truth({ date_kind: "two_dates", date_expect: "refuse" }), guess: { date: "2026-03-04" } },
    { truth: truth({ date: null, date_kind: "none", date_expect: "refuse" }), guess: {} },
  ]);
  assert.deepEqual([s.merchant.correct, s.merchant.answered, s.merchant.contains_name], [1, 2, 2]);
  assert.deepEqual([s.total.correct, s.total.answered, s.total.coverage], [1, 2, 0.4]);
  // A date on an ambiguous receipt is wrong; the purchase date on a two-date receipt is right but not a refusal.
  assert.deepEqual([s.date.correct, s.date.answered, s.date.eligible, s.date.coverage], [2, 3, 2, 0.5]);
  assert.deepEqual([s.date.refused, s.date.should_refuse], [1, 3]);
  assert.deepEqual(wilson(105, 106), [0.948, 0.998]);
  assert.equal(wilson(0, 0), null);
});
