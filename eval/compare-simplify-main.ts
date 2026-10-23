// node eval/compare-simplify-main.ts [--ref 108950d] [--json out.json]
// Runs the bench populations (seed 1: 500 random groups of 2 to 10 people and 500 circle groups of 4 to 10,
// 1 to 30 expenses each) through this checkout's simplifyDebts and through src/lib/debts.ts at --ref
// (default 108950d, main before the October changes), and counts the groups whose payments differ.
// Slow: groups of 9 or 10 people can take seconds each, twice.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { netBalances, pairwiseDebts, simplifyDebts, type Tx } from "../src/lib/debts.ts";
import { randomGroups } from "../tests/random-ledger.ts";

const { values: a } = parseArgs({ options: { ref: { type: "string", default: "108950d" }, json: { type: "string" } } });
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "debts-")), "debts.ts");
fs.writeFileSync(file, execFileSync("git", ["show", `${a.ref}:src/lib/debts.ts`]));
const old = (await import(pathToFileURL(file).href)) as { simplifyDebts: (net: Record<string, number>, raw: Tx[]) => Tx[] };

const out: Record<string, { groups: number; identical: number; differ: number[] }> = {};
for (const [shape, circles, minN] of [["random", false, 2], ["circles", true, 4]] as const) {
  const r = (out[shape] = { groups: 0, identical: 0, differ: [] as number[] });
  for (const [i, g] of randomGroups(1, 500, minN, 10, 1, 30, circles).entries()) {
    const net = netBalances(g.ids, g.entries);
    const raw = pairwiseDebts(g.entries);
    r.groups++;
    if (JSON.stringify(simplifyDebts(net, raw)) === JSON.stringify(old.simplifyDebts(net, raw))) r.identical++;
    else r.differ.push(i);
  }
  console.log(`${shape}: identical payments ${r.identical}/${r.groups}${r.differ.length ? `; differ at ${r.differ.join(",")}` : ""}`);
}
if (a.json) fs.writeFileSync(a.json, JSON.stringify({ date: new Date().toISOString(), ref: a.ref, command: `node eval/compare-simplify-main.ts ${process.argv.slice(2).join(" ")}`.trim(), node: process.version, ...out }, null, 1) + "\n");
if (Object.values(out).some((r) => r.differ.length)) process.exitCode = 1;
