// OCR and scoring shared by `npm run eval:receipts` and tests/receipt-ocr.test.ts.
import path from "node:path";
import { createWorker } from "tesseract.js";
import { parseReceipt } from "../src/lib/receipt.ts";
import type { Truth } from "./receipt-gen.ts";

/**
 * The npm copy of the file the browser loads. ReceiptScanner calls createWorker("eng", 1), and with
 * OEM 1 (LSTM only) tesseract.js fetches @tesseract.js-data/eng/4.0.0_best_int from jsDelivr.
 * Reading it from node_modules keeps the eval and the test offline.
 */
export const LANG_PATH = path.join(import.meta.dirname, "..", "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");

/** Same engine settings as src/components/ReceiptScanner.tsx, minus the UI logger. */
export const ocrWorker = () => createWorker("eng", 1, { langPath: LANG_PATH, cacheMethod: "none" });

export type Guess = { merchant?: string; date?: string; total_cents?: number };

/** What the app would prefill from this text. */
export function guessFrom(text: string): Guess {
  const r = parseReceipt(text);
  return { merchant: r.description, date: r.date, total_cents: r.amount_cents };
}

/** Wilson 95% interval for k of n, rounded to 3 places. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return [r(Math.max(0, c - h)), r(Math.min(1, c + h))];
}

const ratio = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 1000 : null);
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

/** Precision = correct / answered. Coverage = answered / items that have a knowable answer. */
function field(rows: { answered: boolean; correct: boolean; eligible: boolean }[]) {
  const answered = rows.filter((r) => r.answered).length;
  const correct = rows.filter((r) => r.correct).length;
  const eligible = rows.filter((r) => r.eligible).length;
  const answeredEligible = rows.filter((r) => r.eligible && r.answered).length;
  return {
    n: rows.length, answered, correct, wrong: answered - correct,
    precision: ratio(correct, answered), precision_ci95: wilson(correct, answered),
    coverage: ratio(answeredEligible, eligible), eligible,
  };
}

export type Scored = { truth: Truth; guess: Guess };

export function score(rows: Scored[]) {
  const merchant = {
    ...field(rows.map(({ truth, guess }) => ({
      answered: guess.merchant !== undefined, eligible: true,
      correct: guess.merchant !== undefined && norm(guess.merchant) === norm(truth.merchant),
    }))),
    // The name was read right but OCR junk rides along, like ".. Lucky Fox Supply o". Still needs an edit.
    contains_name: rows.filter(({ truth, guess }) => guess.merchant !== undefined && norm(guess.merchant).includes(norm(truth.merchant))).length,
  };
  const total = field(rows.map(({ truth, guess }) => ({
    answered: guess.total_cents !== undefined, eligible: true, correct: guess.total_cents === truth.total_cents,
  })));
  // truth.date is null when the date cannot be known (ambiguous or absent), so any answer there is wrong.
  // On a two-date receipt, suggesting the purchase date is correct but still counts as a missed refusal.
  const date = field(rows.map(({ truth, guess }) => ({
    answered: guess.date !== undefined, eligible: truth.date_expect === "extract",
    correct: guess.date !== undefined && guess.date === truth.date,
  })));
  const refuse = rows.filter((r) => r.truth.date_expect === "refuse");
  const refused = refuse.filter((r) => r.guess.date === undefined).length;
  const byKind: Record<string, { n: number; answered: number; correct: number }> = {};
  for (const { truth, guess } of rows) {
    const k = (byKind[truth.date_kind] ??= { n: 0, answered: 0, correct: 0 });
    k.n++;
    if (guess.date !== undefined) k.answered++;
    if (guess.date !== undefined && guess.date === truth.date) k.correct++;
  }
  return {
    merchant,
    total,
    date: { ...date, should_refuse: refuse.length, refused, refusal_rate: ratio(refused, refuse.length), refusal_ci95: wilson(refused, refuse.length), by_kind: byKind },
  };
}
