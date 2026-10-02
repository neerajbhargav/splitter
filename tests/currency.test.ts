import { test } from "node:test";
import assert from "node:assert/strict";
import { convertCents, getReferenceRate, parseRate, validateRateDate } from "../src/lib/currency.ts";

test("conversion rounds exact half cents upward and preserves the cent model", () => {
  assert.equal(convertCents(1000, 1.1403), 1140);
  assert.equal(convertCents(5, 0.3), 2); // Binary multiplication may give 1.499999...
  assert.equal(convertCents(100, 0.005), 1);
  assert.equal(convertCents(10000, 0.0065), 65); // 100 JPY represented as 10000 ledger cents.
  assert.equal(convertCents(100000000, 1e-8), 1);
  assert.equal(convertCents(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
});

test("conversion rejects unsafe amounts and invalid rates rather than guessing", () => {
  for (const amount of [0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => convertCents(amount, 1));
  for (const rate of [0, -1, NaN, Infinity]) assert.throws(() => convertCents(100, rate));
  assert.throws(() => convertCents(Number.MAX_SAFE_INTEGER, 2));
  assert.throws(() => convertCents(1, 0.001));
});

test("manual rates accept positive plain decimals only", () => {
  assert.equal(parseRate(" 1.1403 "), 1.1403);
  assert.equal(parseRate("0.000000000001"), 1e-12);
  for (const bad of ["", "-1", "0", "Infinity", "1x", "1e2", "1,234", "1.2.3", "0.0000000000001"]) assert.equal(parseRate(bad), null);
});

test("rate dates reject invalid calendar dates and future dates", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  assert.doesNotThrow(() => validateRateDate("2024-02-29", now));
  for (const date of ["2026-02-29", "2026-10-02", "2026-13-01", "2026-10-00", "x"]) assert.throws(() => validateRateDate(date, now));
});

function responder(value: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(value), { status })) as typeof fetch;
}
test("historical reference rate accepts last business day and verifies pair", async () => {
  let requested = "";
  const fetcher = (async (url: string) => { requested = url; return new Response(JSON.stringify({ base: "EUR", quote: "USD", date: "2024-09-27", rate: 1.12 })); }) as typeof fetch;
  const rate = await getReferenceRate("eur", "USD", "2024-09-29", { fetcher, cache: false });
  assert.equal(rate.rate, 1.12);
  assert.equal(rate.date, "2024-09-27");
  assert.match(requested, /providers\/ecb\/rate\/eur\/usd\?date=2024-09-29$/);
  await assert.rejects(getReferenceRate("EUR", "USD", "2024-09-29", { fetcher: responder({ base: "GBP", quote: "USD", date: "2024-09-27", rate: 1.12 }), cache: false }), /invalid rate/);
  await assert.rejects(getReferenceRate("EUR", "USD", "2024-09-29", { fetcher: responder({ base: "EUR", quote: "USD", date: "2024-09-30", rate: 1.12 }), cache: false }), /invalid rate/);
});

test("unsupported pairs and network errors offer manual fallback", async () => {
  await assert.rejects(getReferenceRate("AED", "USD", "2024-01-01", { fetcher: responder({}, 404), cache: false }), /manually/);
  await assert.rejects(getReferenceRate("EUR", "USD", "2024-01-01", { fetcher: (async () => { throw new Error("offline"); }) as typeof fetch, cache: false }), /manually/);
});

test("same currency is exact and does not request a rate", async () => {
  const rate = await getReferenceRate("USD", "USD", "2024-01-01", { fetcher: (async () => { throw new Error("Must not fetch"); }) as typeof fetch });
  assert.deepEqual(rate, { source: "USD", target: "USD", rate: 1, date: "2024-01-01" });
});

test("pair/date caching avoids duplicate calls without mixing dates", async () => {
  let calls = 0;
  const fetcher = (async (url: string) => { calls++; return new Response(JSON.stringify({ base: "CAD", quote: "EUR", date: url.endsWith("2024-03-20") ? "2024-03-20" : "2024-03-21", rate: 0.68 })); }) as typeof fetch;
  await getReferenceRate("CAD", "EUR", "2024-03-20", { fetcher });
  await getReferenceRate("CAD", "EUR", "2024-03-20", { fetcher });
  await getReferenceRate("CAD", "EUR", "2024-03-21", { fetcher });
  assert.equal(calls, 2);
});
