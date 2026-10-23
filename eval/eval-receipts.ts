// npm run eval:receipts [-- --seed 1 --n 200 --json eval/results/receipts-YYYY-MM-DD.json --write-subset]
// Renders seeded synthetic receipts (eval/receipt-gen.ts), reads each one with the app's OCR settings
// (Tesseract.js, English, LSTM only) and the app's parser (src/lib/receipt.ts), and scores merchant,
// date and total. It also runs the parser on each receipt's perfect text, so OCR errors and parser
// limits show up apart. Images go to eval/.cache/ (gitignored). Fully offline after `npm ci`.
// --write-subset copies every 8th image and its truth into tests/fixtures/receipts/, with that
// subset's scores as the baseline for tests/receipt-ocr.test.ts.
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { makeReceipts, receiptText, renderReceipt, type Tier, type Truth } from "./receipt-gen.ts";
import { guessFrom, LANG_PATH, ocrWorker, score, type Guess } from "./receipt-score.ts";

const { values: a } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    n: { type: "string", default: "200" },
    json: { type: "string" },
    "write-subset": { type: "boolean", default: false },
  },
});
const seed = Number(a.seed);
const n = Number(a.n);
const EVERY = 8;
const root = path.join(import.meta.dirname, "..");
const out = a.json ?? path.join("eval", "results", `receipts-${new Date().toISOString().slice(0, 10)}.json`);
const cache = path.join(import.meta.dirname, ".cache", `receipts-seed${seed}`);
fs.mkdirSync(cache, { recursive: true });

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const version = (pkg: string) => JSON.parse(fs.readFileSync(path.join(root, "node_modules", pkg, "package.json"), "utf8")).version as string;
const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" }).trim();

type Item = { id: string; tier: Tier; file: string; sha256: string; truth: Truth; ocr: Guess; text_only: Guess; ocr_ms: number; ocr_text: string };
const items: Item[] = [];
const worker = await ocrWorker();
try {
  for (const spec of makeReceipts(seed, n)) {
    const { bytes, ext } = await renderReceipt(spec);
    const file = `${spec.id}.${ext}`;
    fs.writeFileSync(path.join(cache, file), bytes);
    const t0 = performance.now();
    const { data } = await worker.recognize(bytes);
    const ms = Math.round(performance.now() - t0);
    items.push({ id: spec.id, tier: spec.tier, file, sha256: sha(bytes), truth: spec.truth, ocr: guessFrom(data.text), text_only: guessFrom(receiptText(spec)), ocr_ms: ms, ocr_text: data.text });
  }
} finally {
  await worker.terminate();
}

const ocr = score(items.map((i) => ({ truth: i.truth, guess: i.ocr })));
const byTier = Object.fromEntries((["clean", "mild", "hard"] as const).map((t) => {
  const s = score(items.filter((i) => i.tier === t).map((i) => ({ truth: i.truth, guess: i.ocr })));
  return [t, { n: s.total.n, merchant: s.merchant, total: s.total, date: { ...s.date, by_kind: undefined } }];
}));
const textOnly = score(items.map((i) => ({ truth: i.truth, guess: i.text_only })));
// Of the totals OCR left blank, how many had the right amount on a line that starts with a total label?
// Those are refusals caused by OCR junk around the amount, not by an unreadable total.
const LABEL = /^\W*(?:grand\s*total|total(?:\s*(?:due|amount|paid))?|amount\s*due|balance\s*due)\b/i;
const totalMisses = items.filter((i) => i.ocr.total_cents === undefined);
const amountOnLabelLine = totalMisses.filter((i) => {
  const plain = (i.truth.total_cents / 100).toFixed(2);
  const comma = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return i.ocr_text.split("\n").some((l) => LABEL.test(l.trim()) && !/items|savings|tax/i.test(l) && (l.includes(plain) || l.includes(comma)));
}).length;
const ms = items.map((i) => i.ocr_ms).sort((x, y) => x - y);
const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];

const result = {
  eval: "receipt-extraction",
  generated_at: new Date().toISOString(),
  git: { commit: git("rev-parse HEAD"), dirty: git("status --porcelain") !== "" },
  reproduce: `npm run eval:receipts -- --seed ${seed} --n ${n}`,
  dataset: { generator: "eval/receipt-gen.ts", seed, n, tiers: Object.fromEntries((["clean", "mild", "hard"] as const).map((t) => [t, items.filter((i) => i.tier === t).length])) },
  pipeline: {
    ocr: `tesseract.js ${version("tesseract.js")} (core ${version("tesseract.js-core")}), createWorker("eng", 1): LSTM only, default page segmentation, as in src/components/ReceiptScanner.tsx`,
    lang_data: `@tesseract.js-data/eng ${version("@tesseract.js-data/eng")} 4.0.0_best_int/eng.traineddata.gz sha256 ${sha(fs.readFileSync(path.join(LANG_PATH, "eng.traineddata.gz")))}`,
    parser: "src/lib/receipt.ts parseReceipt",
  },
  environment: { node: process.version, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0]?.model ?? "unknown", sharp: version("sharp"), librsvg: (await import("sharp")).default.versions.rsvg },
  definitions: {
    precision: "correct / answered. A wrong prefill is the costly error, because a user may apply it.",
    coverage: "answered / receipts with a knowable answer (all receipts for merchant and total; date_expect = extract for date).",
    refusal_rate: "receipts with date_expect = refuse (ambiguous numeric day/month, two dates, or no date) where no date was suggested.",
    merchant_match: "case-insensitive, whitespace-collapsed exact match. contains_name counts suggestions that hold the name plus OCR junk.",
    ci95: "Wilson interval.",
  },
  not_scored: "Subtotal and tax are printed on every receipt and kept in each item's truth, but parseReceipt does not extract them.",
  ocr,
  ocr_total_blank: { n: totalMisses.length, right_amount_on_total_line: amountOnLabelLine },
  ocr_by_tier: byTier,
  text_only: textOnly,
  ocr_ms: { p50: pct(0.5), p95: pct(0.95), max: ms[ms.length - 1], note: "One worker, this machine only." },
  items,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 1) + "\n");

const f = (x: number | null) => (x === null ? "  n/a" : (x * 100).toFixed(1).padStart(5) + "%");
const row = (name: string, s: { precision: number | null; coverage: number | null; correct: number; answered: number; precision_ci95: [number, number] | null }) =>
  console.log(`${name.padEnd(22)} precision ${f(s.precision)} (${s.correct}/${s.answered}, CI ${s.precision_ci95?.map((x) => (x * 100).toFixed(1)).join("-") ?? "n/a"})  coverage ${f(s.coverage)}`);
console.log(`receipts n=${n} seed=${seed}  tiers ${JSON.stringify(result.dataset.tiers)}`);
for (const [label, s] of [["ocr", ocr], ["text only", textOnly]] as const) {
  row(`${label} merchant`, s.merchant);
  console.log(`${(label + " merchant").padEnd(22)} name inside the suggestion ${s.merchant.contains_name}/${s.merchant.answered}`);
  row(`${label} total`, s.total);
  row(`${label} date`, s.date);
  console.log(`${(label + " date refusals").padEnd(22)} ${s.date.refused}/${s.date.should_refuse} (${f(s.date.refusal_rate)})`);
}
for (const [t, s] of Object.entries(byTier)) row(`ocr total, ${t}`, s.total);
console.log(`ocr total left blank ${totalMisses.length}, right amount on a total line in ${amountOnLabelLine}`);
console.log(`ocr ms p50 ${result.ocr_ms.p50} p95 ${result.ocr_ms.p95}. Wrote ${out}`);

if (a["write-subset"]) {
  const dir = path.join(root, "tests", "fixtures", "receipts");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const subset = items.filter((_, i) => i % EVERY === 0);
  for (const i of subset) fs.copyFileSync(path.join(cache, i.file), path.join(dir, i.file));
  const s = score(subset.map((i) => ({ truth: i.truth, guess: i.ocr })));
  const manifest = {
    note: `Every ${EVERY}th receipt of ${result.reproduce}. Synthetic. Regenerate with --write-subset.`,
    source: out,
    baseline: { total_precision: s.total.precision, total_coverage: s.total.coverage, total_correct: s.total.correct, total_answered: s.total.answered },
    items: subset.map((i) => ({ id: i.id, file: i.file, sha256: i.sha256, truth: i.truth })),
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(`Subset: ${subset.length} receipts, total ${s.total.correct}/${s.total.answered} correct of ${s.total.n}. Wrote ${dir}`);
}
