// npm run bench:simplify [-- --seed 1 --groups 500 --min-n 2 --max-n 10 --max-e 30 --shape random --cap 250 --compare --json out.json]
// Seeded random groups through the production simplify path. For each group it checks the invariants
// (every balance settles, no relays, at most n-1 payments), compares the payment count with the exact
// subset-DP minimum, and times one uncached call and one memo hit. --cap none turns the time cap off.
// --shape circles keeps each expense inside one circle of members (tests/random-ledger.ts), so many
// groups can settle in fewer than n-1 payments. greedy_at_min counts the groups where plain greedy
// would also reach the minimum: the gap to at_min is what the exact search buys.
// --compare reruns every group that hit the time cap with no cap, and counts how often the capped
// (greedy) answer differs from the uncapped one. It is slow: the uncapped search can take seconds.
import fs from "node:fs";
import os from "node:os";
import { parseArgs } from "node:util";
import { netBalances, pairwiseDebts, simplifyDebts, simplifyDebtsInfo, SIMPLIFY_BUDGET, SIMPLIFY_TIME_CAP_MS } from "../src/lib/debts.ts";
import { fewestPayments, randomGroups } from "../tests/random-ledger.ts";

const { values: a } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    groups: { type: "string", default: "500" },
    "min-n": { type: "string", default: "2" },
    "max-n": { type: "string", default: "10" },
    "max-e": { type: "string", default: "30" },
    shape: { type: "string", default: "random" },
    cap: { type: "string", default: String(SIMPLIFY_TIME_CAP_MS) },
    compare: { type: "boolean", default: false },
    json: { type: "string" },
  },
});
const cfg = {
  seed: Number(a.seed), groups: Number(a.groups), minN: Number(a["min-n"]), maxN: Number(a["max-n"]), minE: 1, maxE: Number(a["max-e"]),
  timeCapMs: a.cap === "none" ? Infinity : Number(a.cap), budget: SIMPLIFY_BUDGET, shape: a.shape,
};
if (cfg.shape !== "random" && cfg.shape !== "circles") throw new Error("--shape is random or circles");

type Row = { n: number; groups: number; atMin: number; greedyAtMin: number; budget: number; time: number; failures: number; raw: number; simplified: number; ms: number[]; hitMs: number[] };
// For groups that hit the time cap (--compare): did the greedy answer match the uncapped search?
const cmp = { groups: 0, sameCount: 0, identical: 0, uncappedBudget: 0, uncappedMs: [] as number[] };
const rows = new Map<number, Row>();
const pct = (xs: number[], p: number) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const load = os.loadavg();

for (const g of randomGroups(cfg.seed, cfg.groups, cfg.minN, cfg.maxN, cfg.minE, cfg.maxE, cfg.shape === "circles")) {
  const net = netBalances(g.ids, g.entries);
  const raw = pairwiseDebts(g.entries);
  const t0 = performance.now();
  const r = simplifyDebtsInfo(net, raw, { timeCapMs: cfg.timeCapMs });
  const ms = performance.now() - t0;
  simplifyDebts(net, raw, { timeCapMs: cfg.timeCapMs }); // fill the memo
  const t1 = performance.now();
  simplifyDebts(net, raw, { timeCapMs: cfg.timeCapMs });
  const hitMs = performance.now() - t1;

  const people = Object.values(net).filter((v) => v !== 0).length;
  const after = { ...net };
  for (const t of r.tx) {
    after[t.from] += t.amount;
    after[t.to] -= t.amount;
  }
  const fewest = fewestPayments(Object.values(net));
  // An exact search (no fallback) must land on the fewest payments; a fallback only has to settle everyone.
  const ok = Object.values(after).every((v) => v === 0) && r.tx.length <= Math.max(0, people - 1)
    && r.tx.every((t) => Number.isSafeInteger(t.amount) && t.amount > 0 && net[t.from] < 0 && net[t.to] > 0)
    && (r.fallback !== null || r.tx.length === fewest);

  const row = rows.get(g.ids.length) ?? { n: g.ids.length, groups: 0, atMin: 0, greedyAtMin: 0, budget: 0, time: 0, failures: 0, raw: 0, simplified: 0, ms: [], hitMs: [] };
  row.groups++;
  if (r.tx.length === fewest) row.atMin++;
  if (simplifyDebtsInfo(net, raw, { budget: 0 }).tx.length === fewest) row.greedyAtMin++;
  if (r.fallback === "budget") row.budget++;
  if (r.fallback === "time") row.time++;
  if (!ok) row.failures++;
  row.raw += raw.length;
  row.simplified += r.tx.length;
  row.ms.push(ms);
  row.hitMs.push(hitMs);
  rows.set(g.ids.length, row);

  if (a.compare && r.fallback === "time") {
    const t2 = performance.now();
    const full = simplifyDebtsInfo(net, raw, { timeCapMs: Infinity });
    cmp.uncappedMs.push(performance.now() - t2);
    cmp.groups++;
    if (full.tx.length === r.tx.length) cmp.sameCount++;
    if (JSON.stringify(full.tx) === JSON.stringify(r.tx)) cmp.identical++;
    if (full.fallback === "budget") cmp.uncappedBudget++;
  }
}

const all = [...rows.values()].sort((x, y) => x.n - y.n);
const sum = (k: "groups" | "atMin" | "greedyAtMin" | "budget" | "time" | "failures" | "raw" | "simplified") => all.reduce((s, r) => s + r[k], 0);
const ms = all.flatMap((r) => r.ms);
const hits = all.flatMap((r) => r.hitMs);
const f = (x: number) => (x < 10 ? x.toFixed(2) : x.toFixed(0));
const red = (raw: number, simp: number) => (raw ? `${(100 * (1 - simp / raw)).toFixed(1)}%` : "-");
const cap = cfg.timeCapMs === Infinity ? "none" : `${cfg.timeCapMs}ms`;

const lines = [
  `simplify bench: shape=${cfg.shape} seed=${cfg.seed} people=${cfg.minN}-${cfg.maxN} expenses=${cfg.minE}-${cfg.maxE} cap=${cap} budget=${cfg.budget}`,
  `node ${process.version} ${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? "?"}, load avg ${load.map((x) => x.toFixed(1)).join(" ")}`,
  `groups=${sum("groups")} at_min=${sum("atMin")}/${sum("groups")} greedy_at_min=${sum("greedyAtMin")}/${sum("groups")} invariant_failures=${sum("failures")} fallback_budget=${sum("budget")} fallback_time=${sum("time")}`,
  `uncached ms: p50=${f(pct(ms, 0.5))} p95=${f(pct(ms, 0.95))} max=${f(Math.max(...ms))}   memo hit ms: p50=${f(pct(hits, 0.5))} max=${f(Math.max(...hits))}`,
  `payments: raw=${sum("raw")} simplified=${sum("simplified")} reduction=${red(sum("raw"), sum("simplified"))}`,
  ...(a.compare ? [`time-capped groups rerun with no cap: ${cmp.groups}; same payment count ${cmp.sameCount}/${cmp.groups}; identical payments ${cmp.identical}/${cmp.groups}; uncapped hit the budget ${cmp.uncappedBudget}/${cmp.groups}; uncapped ms p50=${f(pct(cmp.uncappedMs, 0.5))} max=${f(Math.max(0, ...cmp.uncappedMs))}`] : []),
  "",
  " n  groups  at_min  greedy_at_min  fb_budget  fb_time  failures  p50_ms  p95_ms  max_ms   raw  simplified  reduction",
  ...all.map((r) => [
    String(r.n).padStart(2), String(r.groups).padStart(7), `${r.atMin}/${r.groups}`.padStart(7), `${r.greedyAtMin}/${r.groups}`.padStart(14), String(r.budget).padStart(10), String(r.time).padStart(8),
    String(r.failures).padStart(9), f(pct(r.ms, 0.5)).padStart(7), f(pct(r.ms, 0.95)).padStart(7), f(Math.max(...r.ms)).padStart(7),
    String(r.raw).padStart(5), String(r.simplified).padStart(11), red(r.raw, r.simplified).padStart(10),
  ].join(" ")),
];
console.log(lines.join("\n"));

if (a.json) {
  const out = {
    date: new Date().toISOString(), command: `npm run bench:simplify -- ${process.argv.slice(2).join(" ")}`.trim(),
    config: { ...cfg, timeCapMs: cap }, node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, loadavg: load,
    compare_time_capped: a.compare ? { groups: cmp.groups, same_count: cmp.sameCount, identical: cmp.identical, uncapped_hit_budget: cmp.uncappedBudget, uncapped_ms: { p50: pct(cmp.uncappedMs, 0.5), max: Math.max(0, ...cmp.uncappedMs) } } : null,
    totals: { groups: sum("groups"), at_min: sum("atMin"), greedy_at_min: sum("greedyAtMin"), invariant_failures: sum("failures"), fallback_budget: sum("budget"), fallback_time: sum("time"), raw_payments: sum("raw"), simplified_payments: sum("simplified"), uncached_ms: { p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(...ms) }, memo_hit_ms: { p50: pct(hits, 0.5), max: Math.max(...hits) } },
    by_n: all.map((r) => ({ n: r.n, groups: r.groups, at_min: r.atMin, greedy_at_min: r.greedyAtMin, fallback_budget: r.budget, fallback_time: r.time, invariant_failures: r.failures, raw_payments: r.raw, simplified_payments: r.simplified, ms: { p50: pct(r.ms, 0.5), p95: pct(r.ms, 0.95), max: Math.max(...r.ms) } })),
  };
  fs.writeFileSync(a.json, JSON.stringify(out, null, 1) + "\n");
}
if (sum("failures")) process.exitCode = 1;
