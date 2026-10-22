# Evals

Two offline scripts live here. Neither needs a key, a network call or a database.

- `npm run eval:receipts` scores receipt extraction (this page).
- `npm run bench:simplify` checks and times debt simplification ([below](#debt-simplification)).

## Receipt extraction

The receipt scanner prefills three fields for the user to review: merchant, total and date. It is built to leave a field blank rather than guess. This eval measures how often a prefilled value is wrong (precision), how often a field is filled at all (coverage), and how often an unknowable date is left blank (refusal rate).

### Results

Source: [`results/receipts-2026-10-22.json`](results/receipts-2026-10-22.json). Run on 2026-10-22 at commit `40e5d16`, Node 24.17.0, Apple M4 Pro.

Caveats first:

- The receipts are synthetic. They are rendered from SVG, not photographed, so they lack real lighting, curled paper and thermal fade. The tiers are a stress test, not a model of real photos.
- n = 200, so a 100% row still has a 95% interval that reaches down to about 95%. Intervals are Wilson intervals.
- Pixels depend on the fonts installed. Each image's SHA-256 is in the results file. On another machine the images can differ, and so can the numbers.
- Subtotal and tax are printed on every receipt and kept in the ground truth, but the app does not extract them, so they are not scored.

| Field | Input | Precision (correct / answered) | 95% CI | Coverage | Refusals on unknowable dates |
|---|---|---|---|---|---|
| Total | OCR | 99.1% (105/106) | 94.8 to 99.8% | 53.0% (106/200) | |
| Total | Perfect text | 100% (200/200) | 98.1 to 100% | 100% | |
| Date | OCR | 98.6% (71/72) | 92.5 to 99.8% | 59.8% (70/117) | 97.6% (81/83) |
| Date | Perfect text | 100% (99/99) | 96.3 to 100% | 84.6% (99/117) | 100% (83/83) |
| Merchant | OCR | 57.8% (100/173) | 50.4 to 64.9% | 86.5% (173/200) | |
| Merchant | Perfect text | 93.0% (186/200) | 88.6 to 95.8% | 100% | |

OCR total by tier:

| Tier | Receipts | Precision | Coverage |
|---|---|---|---|
| Clean | 73 | 100% (72/72) | 98.6% |
| Mild | 75 | 100% (26/26) | 34.7% |
| Hard | 52 | 87.5% (7/8) | 15.4% |

Pipeline: tesseract.js 7.0.0 (core 7.0.0), `createWorker("eng", 1)`, and `parseReceipt` from `src/lib/receipt.ts`. Dataset: `receipt-gen.ts`, seed 1, n 200.

### What the numbers say

- A wrong total is rare. OCR filled 106 totals and 1 was wrong: a hard receipt where "Balance Due 7.04" was read as "Balance Due 04".
- Blank totals are the cost of that caution. OCR left 94 totals blank. In 50 of them the right amount was on a line that starts with a total label, but OCR junk on that line broke the parser's strict pattern. Examples: "TOTAL 0 USD 177.13" and "+ Total 52.54". The parser wants the label to open the line and the rest to be one amount. That is the first place to gain coverage, and this eval is how to check that precision holds.
- The date parser never guesses on numeric dates. It left all 48 ambiguous ones (like 04/08/2026) blank, and also the 18 with only one valid reading (like 03/14/2026). Those 18 are why perfect-text coverage is 84.6%.
- OCR misread one year: "July 14, 2024" became "July 14, 2074", and the parser accepted it. The receipt also had a return-by date that OCR garbled, so it was a missed refusal too.
- Merchant precision under OCR is low mostly because junk rides along with the name. 139 of the 173 merchant suggestions contain the exact name, as in ". Lucky Fox Supply o". On perfect text, the 14 misses are all names with a digit, like "Pier 34 Supply". The header rule skips lines with digits, so it picks the town line instead.

### Method

`receipt-gen.ts` builds each receipt from a seed: a fictional merchant (about 8% contain a digit), a fictional street, town and 555-01xx phone, a date line, 2 to 6 items, then subtotal, tax, an optional tip, the total under one of 7 label spellings, and cash with change or a card line. Some receipts add distractors: "Total Items", "Total Savings", and a "Return by" date. Every line goes into an SVG, and sharp (librsvg) renders it.

Date formats and what the parser should do:

| Kind | Example | Expected |
|---|---|---|
| ISO | 2025-02-17 | fill |
| Month name first | Mar. 4, 2026 or March 4 2026 | fill |
| Day first | 4th March, 2026 | fill |
| Numeric, one valid reading | 03/14/2026 | fill is possible, the parser leaves it blank by design |
| Numeric, ambiguous | 04/08/2026, 04-08-26, 04.08.2026 | blank |
| Two dates | purchase date plus "Return by" | blank |
| None | | blank |

Tiers:

- Clean (35%): a flat scan, black on white, no noise.
- Mild (35%): the paper on a table, rotated up to 1.5 degrees, blur 0.4 to 0.7 px, 150 to 500 specks, up to 1 crease, dark gray ink, JPEG quality 70 to 90 half the time.
- Hard (30%): rotated 2.5 to 6 degrees, blur 0.7 to 1.1 px, 700 to 1800 specks, 1 to 3 creases, gray ink on gray paper, JPEG quality 35 to 60.

Each image goes through the app's own OCR settings and parser. The English data is the npm copy of the file the browser downloads from jsDelivr: `@tesseract.js-data/eng` 1.0.0, `4.0.0_best_int/eng.traineddata.gz`, SHA-256 `45b4cb34...ff91`. Each receipt's perfect text also goes through the parser alone. That splits OCR errors from parser limits.

Scoring:

- Precision is correct / answered. A wrong prefill is the costly error, because the user may apply it.
- Coverage is answered / receipts with a knowable answer. For date, that is the 117 receipts marked "fill".
- Refusal rate is blank dates / the 83 receipts marked "blank".
- Merchant must match exactly, ignoring case and extra spaces. A suggestion that holds the name plus junk is reported separately as `contains_name`.
- A date is correct only if it equals the purchase date. On a two-date receipt the purchase date counts as correct and as a missed refusal.

Three runs on the same machine gave identical images and identical OCR text for all 200 receipts.

### Commands

```sh
npm ci
npm run eval:receipts                    # about 35 s; writes results/receipts-<UTC date>.json
npm run eval:receipts -- --seed 2 --n 500 --json /tmp/receipts.json
node --test tests/receipt-ocr.test.ts    # the CI gate alone, about 4 s
```

Rendered images go to `eval/.cache/` (gitignored).

### The CI gate

`tests/receipt-ocr.test.ts` runs in `npm test`. It reads the 25 committed receipts in `tests/fixtures/receipts/` (every 8th receipt of the seed 1 run) and fails if total precision or total coverage falls below the baseline in `manifest.json`. That baseline is 14 of 14 totals correct and 14 of 25 filled. Coverage is gated too, because a parser that leaves every total blank would keep precision perfect. A planted change that falls back to the largest amount on the receipt fails the gate (checked by hand on 2026-10-22).

To accept a new baseline on purpose, rerun with `--write-subset` and commit the new results file and fixtures together.

Tesseract's WebAssembly build uses relaxed SIMD where the CPU has it, so OCR text can differ slightly between machines. The baseline was recorded on an Apple M4 Pro and passes on the Linux runner in CI.

## Debt simplification

"Simplify debts" turns a group's balances into a short list of payments. `npm run bench:simplify` runs seeded groups through `simplifyDebtsInfo`, the search behind the group page and the dashboard. For every group it checks four things: every balance settles, nobody who is owed money pays and nobody who owes receives (no relays), the group uses at most n-1 payments (n = people with a balance), and an exact answer uses the fewest payments possible. The fewest is computed by an independent subset DP in `tests/random-ledger.ts`: n minus the most zero-sum parts the balances split into.

### Results

Sources: [`results/simplify-bench-2026-10-22.json`](results/simplify-bench-2026-10-22.json), [`results/simplify-bench-circles-2026-10-22.json`](results/simplify-bench-circles-2026-10-22.json) and [`results/simplify-bench-circles-cap2-2026-10-22.json`](results/simplify-bench-circles-cap2-2026-10-22.json), each with a `.txt` copy of the printed table. Run on 2026-10-22 with `src/lib/debts.ts` as of `2530b66`, Node 24.17.0, Apple M4 Pro, seed 1, 500 groups per run, 1 to 30 expenses per group.

Caveats first:

- The groups are synthetic. In "random" groups each expense is shared by a random subset of everyone. In "circles" groups the members form 2 to n/2 circles (like couples in a house) and each expense stays inside one circle, so a circle can settle on its own.
- The times come from one laptop with a load average of about 5 from other work. Treat them as rough. The counts are seeded and repeat on any machine, except which groups hit the time cap.
- `greedy_at_min` counts the groups where plain greedy (biggest debtor pays biggest creditor) also reaches the fewest payments. The gap between it and `at_min` is what the exact search adds.

| Run | People | at_min | greedy_at_min | Invariant failures | Time cap fired | ms p50 / p95 / max | Payments, raw to simplified |
|---|---|---|---|---|---|---|---|
| Random, 250 ms cap | 2 to 10 | 500/500 | 500/500 | 0 | 53 | 0.12 / 251 / 253 | 7,741 to 2,432 (68.6% fewer) |
| Circles, 250 ms cap | 4 to 10 | 500/500 | 368/500 | 0 | 0 | 0.02 / 0.42 / 22 | 3,136 to 1,965 (37.3% fewer) |
| Circles, 2 ms cap | 4 to 10 | 500/500 | 368/500 | 0 | 5 | 0.02 / 0.44 / 3.7 | 3,136 to 1,965 (37.3% fewer) |

Random groups by size (250 ms cap):

| People | Groups | Time cap fired | p95 ms | Max ms | Payments, raw to simplified |
|---|---|---|---|---|---|
| 2 | 52 | 0 | 0.04 | 0.04 | 52 to 52 (0.0% fewer) |
| 3 | 57 | 0 | 0.05 | 0.05 | 166 to 113 (31.9% fewer) |
| 4 | 63 | 0 | 0.06 | 0.09 | 367 to 189 (48.5% fewer) |
| 5 | 58 | 0 | 0.15 | 0.25 | 559 to 231 (58.7% fewer) |
| 6 | 53 | 0 | 0.78 | 0.86 | 714 to 263 (63.2% fewer) |
| 7 | 59 | 0 | 5.7 | 5.9 | 1,083 to 342 (68.4% fewer) |
| 8 | 54 | 0 | 66 | 70 | 1,224 to 369 (69.9% fewer) |
| 9 | 54 | 16 | 252 | 252 | 1,710 to 429 (74.9% fewer) |
| 10 | 50 | 37 | 252 | 253 | 1,866 to 444 (76.2% fewer) |

A memo hit (the same ledger again, as on a refetch) took at most 0.06 ms.

### What the numbers say

- On random groups the exact search never beats greedy. Their balances do not split into zero-sum parts, so n-1 payments is the minimum, and greedy reaches it too. A test that only uses such groups cannot tell the exact search from greedy.
- On circle groups greedy misses the minimum in 132 of 500. The exact search reaches it in all 500, and the slowest one took 22 ms.
- Large random groups are the slow case. For 9 and 10 people the search hit the 250 ms cap in 53 of 104 groups. Rerun with no cap, all 53 kept the same payment count. 17 gave identical payments, because the uncapped search also ran out of combinations (after up to 2 s). The other 36 suggest different payer and payee pairs than the uncapped search.
- The cap rarely costs a payment. With a 2 ms cap, 5 circle groups fell back to greedy and all 5 kept the fewest payments. A 2 ms cap on this laptop stands in for the 250 ms cap on a device about 100 times slower (assumed: search time scales with device speed).

### Where the search falls back

`simplifyDebtsInfo` tries sets of payment routes from people who owe to people who are owed, starting at the subset-DP minimum and going up. It stops early in two cases and then returns greedy:

1. after 300,000 route combinations (`SIMPLIFY_BUDGET`), the limit the app always had;
2. after 250 ms of wall-clock time (`SIMPLIFY_TIME_CAP_MS`, the clock is read every 256 combinations).

Greedy settles everyone with no relays in at most n-1 payments, but it can use more than the fewest. `fallback` in the result says which stop fired. With more than 16 people with a balance, the DP bound is skipped and the search starts at n-1. A time-capped answer can differ between a fast and a slow device for the same ledger.

`tests/simplify-property.test.ts` runs in `npm test` with no time cap: 300 random groups of 2 to 7 people and 300 circle groups of 4 to 8 people. In all 600 the search is exact and uses the fewest payments. Both sets match golden digests computed by `debts.ts` as it was on `main` (`108950d`), before the memo and the time cap.

### Commands

```sh
npm run bench:simplify                                       # random groups, about 40 s
npm run bench:simplify -- --shape circles --min-n 4          # circle groups, under 1 s
npm run bench:simplify -- --compare --json /tmp/simplify.json # also rerun time-capped groups with no cap
```
