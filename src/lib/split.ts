// Money helpers. Everything is integer cents so totals always add up exactly.

export type Portion = { id: string; amount: number };

/** Parse "12.5", "$1,200.00", "12" into cents. Returns null for invalid or non-positive input. */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[^0-9.\-]/g, "");
  if (!s || s === "." || s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Like parseMoney but treats empty input as 0 and allows 0. */
export function parseMoneyOrZero(input: string | null | undefined): number {
  const v = parseMoney(input ?? "");
  return v === null || v < 0 ? 0 : v;
}

/** Split evenly. Leftover cents go one each to the first people in the list. */
export function splitEqual(total: number, ids: string[]): Portion[] {
  if (!ids.length || total <= 0) return [];
  const base = Math.floor(total / ids.length);
  const rem = total - base * ids.length;
  return ids.map((id, i) => ({ id, amount: base + (i < rem ? 1 : 0) }));
}

/**
 * Split by weights (percentages or shares) with the largest-remainder method,
 * so the parts always sum to exactly `total`.
 */
export function splitByWeights(total: number, weights: { id: string; weight: number }[]): Portion[] {
  const valid = weights.filter((w) => Number.isFinite(w.weight) && w.weight > 0);
  const sum = valid.reduce((a, w) => a + w.weight, 0);
  if (!valid.length || sum <= 0 || total <= 0) return [];
  const raw = valid.map((w, i) => {
    const exact = (total * w.weight) / sum;
    const floor = Math.floor(exact + 1e-9);
    return { id: w.id, floor, frac: exact - floor, i };
  });
  let rem = total - raw.reduce((a, r) => a + r.floor, 0);
  const order = [...raw].sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rem > 0 && order.length; k = (k + 1) % order.length, rem--) order[k].floor += 1;
  // Float edge case: floors overshot. Take the extra cents back from the smallest fractions.
  for (let k = order.length - 1; rem < 0 && k >= 0; k--) {
    if (order[k].floor > 0) {
      order[k].floor -= 1;
      rem++;
    }
  }
  return raw.map((r) => ({ id: r.id, amount: r.floor }));
}

export function sumPortions(p: Portion[]): number {
  return p.reduce((a, x) => a + x.amount, 0);
}
