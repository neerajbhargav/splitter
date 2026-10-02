/** Free ECB reference rates via Frankfurter. The ledger uses hundredths for every
 * currency (including JPY), matching the rest of SPLITTER's integer-cent model. */
export type ReferenceRate = { source: string; target: string; rate: number; date: string };
export type ConversionResult = {
  amount_cents: number; source_currency: string; source_amount_cents: number; fx_rate: number; fx_date: string;
};
const cache = new Map<string, { rate: ReferenceRate; saved: number }>();
const TTL = 24 * 60 * 60 * 1000;
const PREFIX = "splitter:fx:ecb:v2:";

function localDay(now = new Date()): string {
  const d = new Date(now); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
export function validateRateDate(date: string, now = new Date()): void {
  const parsed = new Date(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new Error("Choose a valid rate date.");
  if (date > localDay(now)) throw new Error("Future reference rates are not available. Choose today or an earlier date.");
}
export function parseRate(input: string): number | null {
  if (!/^\d+(\.\d{1,12})?$/.test(input.trim())) return null;
  const rate = Number(input.trim());
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}
/** Decimal rational arithmetic avoids binary-float half-cent rounding errors. */
export function convertCents(sourceCents: number, rate: number): number {
  if (!Number.isSafeInteger(sourceCents) || sourceCents <= 0) throw new Error("Enter a positive source amount within the supported range.");
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Enter a positive exchange rate.");
  const [coefficient, exponent = "0"] = rate.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const power = Number(exponent) - fraction.length;
  let numerator = BigInt(whole + fraction); let denominator = 1n;
  if (power >= 0) numerator *= 10n ** BigInt(power);
  else denominator = 10n ** BigInt(-power);
  const scaled = BigInt(sourceCents) * numerator;
  const rounded = (scaled * 2n + denominator) / (2n * denominator);
  if (rounded <= 0n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The converted amount is outside the supported range.");
  return Number(rounded);
}
function normalizeCurrency(currency: string): string {
  const result = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw new Error("Choose a three-letter currency code.");
  return result;
}
function isRate(value: unknown, source: string, target: string, requested: string): value is ReferenceRate {
  if (!value || typeof value !== "object") return false;
  const r = value as ReferenceRate;
  if (r.source !== source || r.target !== target || !Number.isFinite(r.rate) || r.rate <= 0 || typeof r.date !== "string") return false;
  try { validateRateDate(r.date); } catch { return false; }
  return r.date <= requested;
}
export async function getReferenceRate(sourceCurrency: string, targetCurrency: string, date: string, options: {
  fetcher?: typeof fetch; signal?: AbortSignal; cache?: boolean;
} = {}): Promise<ReferenceRate> {
  validateRateDate(date);
  const source = normalizeCurrency(sourceCurrency), target = normalizeCurrency(targetCurrency);
  if (source === target) return { source, target, rate: 1, date };
  const key = PREFIX + source + ":" + target + ":" + date;
  if (options.cache !== false) {
    let stored = cache.get(key);
    if (!stored && typeof localStorage !== "undefined") {
      try { stored = JSON.parse(localStorage.getItem(key) || "null"); } catch { /* Cache is optional. */ }
    }
    if (stored && Number.isFinite(stored.saved) && Date.now() - stored.saved >= 0 && Date.now() - stored.saved < TTL && isRate(stored.rate, source, target, date)) return stored.rate;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try {
    const response = await (options.fetcher ?? fetch)(`https://api.frankfurter.dev/v2/providers/ecb/rate/${source.toLowerCase()}/${target.toLowerCase()}?date=${date}`, { signal: controller.signal });
    if (!response.ok) throw new Error("No ECB reference rate is available for this pair/date. Enter your actual exchange rate manually.");
    const payload = await response.json() as { base?: string; quote?: string; rate?: number; date?: string };
    const result = { source: payload.base, target: payload.quote, rate: payload.rate, date: payload.date };
    if (!isRate(result, source, target, date)) throw new Error("The exchange-rate service returned an invalid rate. Enter a rate manually.");
    if (options.cache !== false) {
      const stored = { rate: result, saved: Date.now() }; cache.set(key, stored);
      if (typeof localStorage !== "undefined") { try { localStorage.setItem(key, JSON.stringify(stored)); } catch { /* Cache is optional. */ } }
    }
    return result;
  } catch (error) {
    if (error instanceof Error && /reference rate|invalid rate/.test(error.message)) throw error;
    throw new Error("Could not load the rate. Check your connection or enter a rate manually.");
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
  }
}
