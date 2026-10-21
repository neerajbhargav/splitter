// Money helpers. Everything is integer cents so totals always add up exactly.

export type Portion = { id: string; amount: number };

/** Parse "12.5", "$1,200.00", "12" into cents. Returns null for invalid or non-positive input. */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input * 100) : null;
  // Accept "$1,234.56", "1234.5", "-12", " 12 ". Reject anything else ("1e2", "12abc", "1.2.3").
  const t = input.trim().replace(/^(-?)\$\s*/, "$1");
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)?(\.\d*)?$/.test(t) || !/\d/.test(t)) return null;
  const neg = t.startsWith("-");
  const [whole, frac = ""] = t.replace(/[-,]/g, "").split(".");
  // Exact decimal to cents, rounding half up on the third decimal.
  const f = (frac + "000").slice(0, 3);
  const cents = Number(whole || "0") * 100 + Number(f.slice(0, 2)) + (Number(f[2]) >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
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

const dayNo = (iso: string) => Date.parse(iso + "T00:00:00Z") / 864e5;

/** Days of the inclusive period [from, to] that fall inside a stay. Open stay ends count as unbounded. */
export function daysStayed(from: string, to: string, stayFrom?: string | null, stayTo?: string | null): number {
  const a = Math.max(dayNo(from), stayFrom ? dayNo(stayFrom) : -Infinity);
  const b = Math.min(dayNo(to), stayTo ? dayNo(stayTo) : Infinity);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a + 1 : 0;
}

/**
 * Split a bill by how many days of its period each person lived there (largest remainder,
 * so the parts sum to exactly `total`). People with no days in the period are left out.
 */
export function splitByDays(
  total: number, from: string, to: string, people: { id: string; stay_from?: string | null; stay_to?: string | null }[],
): (Portion & { days: number })[] {
  const days = new Map(people.map((p) => [p.id, daysStayed(from, to, p.stay_from, p.stay_to)]));
  return splitByWeights(total, people.map((p) => ({ id: p.id, weight: days.get(p.id)! })))
    .map((p) => ({ ...p, days: days.get(p.id)! }));
}

export function sumPortions(p: Portion[]): number {
  return p.reduce((a, x) => a + x.amount, 0);
}
