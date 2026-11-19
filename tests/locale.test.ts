import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney } from "../src/lib/split.ts";
import { appLocale, isNewProfile, localeCurrency, regionalCurrency } from "../src/lib/locale.ts";
import { money } from "../src/lib/format.ts";

test("US amounts parse exactly as before", () => {
  for (const [input, cents] of [["12.5", 1250], ["$1,200.00", 120000], ["12", 1200], ["-12", -1200], [" 12 ", 1200], ["1,234.56", 123456], ["1,500", 150000], ["0.005", 1]] as const) {
    assert.equal(parseMoney(input), cents, input);
  }
  for (const bad of ["1e2", "12abc", "1.2.3", "", "abc", "$"]) assert.equal(parseMoney(bad), null, bad);
});

test("amounts typed the way other regions write them", () => {
  const cases: [string, number][] = [
    ["12,50", 1250], ["12,5", 1250], ["1.234,56", 123456], ["1 234,56", 123456], ["1\u202f234,56", 123456], ["1'234.50", 123450],
    ["€12", 1200], ["12 €", 1200], ["12,50 €", 1250], ["£7.20", 720], ["₹1,250", 125000], ["R$ 10,90", 1090], ["US$5", 500],
    ["12 EUR", 1200], ["EUR 12.40", 1240], ["¥1,000", 100000], ["-€3,10", -310],
  ];
  for (const [input, cents] of cases) assert.equal(parseMoney(input), cents, input);
});

test("a region maps to its currency, and the server and tests stay en-US", () => {
  assert.equal(localeCurrency("en-US"), "USD");
  assert.equal(localeCurrency("en-IN"), "INR");
  assert.equal(localeCurrency("hi"), "INR");
  assert.equal(localeCurrency("de-DE"), "EUR");
  assert.equal(localeCurrency("fr"), "EUR");
  assert.equal(localeCurrency("en-GB"), "GBP");
  assert.equal(localeCurrency("ja-JP"), "JPY");
  assert.equal(localeCurrency("pt-BR"), "BRL");
  assert.equal(localeCurrency("xx-ZZ"), null);
  assert.equal(appLocale(), "en-US");
  assert.equal(money(123456, "USD"), "$1,234.56");
});

test("the time zone decides the currency before the language does", () => {
  assert.equal(regionalCurrency("America/New_York", "en-IN"), "USD", "an English (India) phone in New Jersey starts in dollars");
  assert.equal(regionalCurrency("Asia/Kolkata", "en-US"), "INR");
  assert.equal(regionalCurrency("Europe/London", "en-US"), "GBP");
  assert.equal(regionalCurrency("Europe/Berlin", "en-US"), "EUR");
  assert.equal(regionalCurrency("Australia/Sydney", "en-GB"), "AUD");
  assert.equal(regionalCurrency("Antarctica/Troll", "de-DE"), "EUR", "an unknown zone falls back to the language region");
  assert.equal(regionalCurrency(null, "ja-JP"), "JPY");
  assert.equal(regionalCurrency(undefined, "xx"), null);
});

test("only a profile made in the last 10 minutes counts as new, so existing accounts never change currency", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(isNewProfile({ created_at: "2026-11-18T11:55:00Z" }, now), true);
  assert.equal(isNewProfile({ created_at: "2026-11-18T11:49:00Z" }, now), false);
  assert.equal(isNewProfile({ created_at: "2026-10-01T04:00:00Z" }, now), false);
  assert.equal(isNewProfile({ created_at: null }, now), false);
  assert.equal(isNewProfile(null, now), false);
});
