import { test } from "node:test";
import assert from "node:assert/strict";
import { localDate, matchAccount, planPurchase, purchaseCents, purchaseMessage, sameMerchant, type PurchaseContext } from "../src/lib/purchase-log.ts";

const ctx: PurchaseContext = {
  currency: "USD",
  accounts: [
    { id: "acc-apple", name: "Apple Card", last4: null, type: "credit" },
    { id: "acc-chase", name: "Sapphire Preferred", last4: "4821", type: "credit" },
    { id: "acc-check", name: "Checking", last4: "1100", type: "checking" },
  ],
  categories: [
    { id: "cat-dining", name: "Dining" },
    { id: "cat-groceries", name: "Groceries" },
    { id: "cat-coffee", name: "Coffee" },
  ],
  history: [
    { description: "STARBUCKS STORE #1234 NEW YORK NY", category_id: "cat-coffee", date: "2026-11-10" },
    { description: "Starbucks", category_id: "cat-dining", date: "2026-10-01" },
  ],
};

test("amounts from Shortcuts parse to cents in the formats Wallet uses", () => {
  assert.equal(purchaseCents("$4.75"), 475);
  assert.equal(purchaseCents("USD 1,234.50"), 123450);
  assert.equal(purchaseCents("4,75 €"), 475);
  assert.equal(purchaseCents("1.234,50"), 123450);
  assert.equal(purchaseCents(12), 1200);
  assert.equal(purchaseCents("-$3.00"), 300, "a sign from the card network is ignored; Apple Pay taps are purchases");
  assert.equal(purchaseCents(""), null);
  assert.equal(purchaseCents("$0.00"), null);
  assert.equal(purchaseCents(undefined), null);
});

test("the category is the one last used at that merchant, else a keyword guess, else none", () => {
  const coffee = planPurchase({ amount: "$5.10", merchant: "Starbucks", card: "Apple Card" }, ctx, "2026-11-18");
  assert.ok(!("error" in coffee));
  assert.equal(coffee.category, "Coffee", "newest history row for the same normalized merchant wins");
  assert.equal(coffee.how, "history");
  assert.equal(coffee.row.account_id, "acc-apple");

  const groceries = planPurchase({ amount: "$62.40", merchant: "Whole Foods Market", card: "Checking" }, ctx, "2026-11-18");
  assert.ok(!("error" in groceries));
  assert.equal(groceries.how, "keyword");
  assert.equal(groceries.category, "Groceries");

  const unknown = planPurchase({ amount: "$9", merchant: "Zqx Holdings", card: "" }, ctx, "2026-11-18");
  assert.ok(!("error" in unknown));
  assert.equal(unknown.category, null);
  assert.equal(unknown.row.category_id, undefined);
  assert.equal(unknown.row.account_id, undefined);
});

test("a clean Wallet merchant name matches its bank-statement form, but not a different merchant", () => {
  assert.ok(sameMerchant("starbucks", "starbucks store new york"));
  assert.ok(sameMerchant("blue bottle coffee", "blue bottle"));
  assert.ok(!sameMerchant("star", "starbucks"), "no match inside a word");
  assert.ok(!sameMerchant("bp", "bp gas station"), "names under 4 letters must match exactly");
  assert.ok(!sameMerchant("", "starbucks"));
});

test("cards match accounts by name, last 4, or one unique partial name", () => {
  assert.equal(matchAccount("apple card", ctx.accounts)?.id, "acc-apple");
  assert.equal(matchAccount("Chase •••• 4821", ctx.accounts)?.id, "acc-chase");
  assert.equal(matchAccount("Chase Sapphire Preferred", ctx.accounts)?.id, "acc-chase");
  assert.equal(matchAccount("Visa", ctx.accounts), null);
  assert.equal(matchAccount("", ctx.accounts), null);
  const twins = [{ id: "a", name: "Card", last4: "1111", type: "credit" }, { id: "b", name: "Card Plus", last4: "1111", type: "credit" }];
  assert.equal(matchAccount("Card 1111", twins)?.id, "a", "an exact name beats an ambiguous last 4");
  assert.equal(matchAccount("Gold 1111", twins), null, "two accounts with the same last 4 match neither");
});

test("description falls back to the transaction name, then the card; dates come from the sender or today", () => {
  const named = planPurchase({ amount: "3", name: "MTA*NYCT PAYGO" }, ctx, "2026-11-18");
  assert.ok(!("error" in named));
  assert.equal(named.row.description, "MTA*NYCT PAYGO");
  assert.equal(named.row.date, "2026-11-18");
  const cardOnly = planPurchase({ amount: "3", card: "Apple Card", date: "2026-11-17T23:59:00-05:00" }, ctx, "2026-11-18");
  assert.ok(!("error" in cardOnly));
  assert.equal(cardOnly.row.description, "Apple Pay · Apple Card");
  assert.equal(cardOnly.row.date, "2026-11-17");
  assert.deepEqual(planPurchase({ merchant: "Starbucks" }, ctx, "2026-11-18"), { error: "The Shortcut sent no amount. Check that Amount is in the request body." });
});

test("local dates follow the user's time zone, and the notification reads naturally", () => {
  const lateNight = new Date("2026-11-19T02:30:00Z"); // 9:30 PM in New York on Nov 18
  assert.equal(localDate(lateNight, "America/New_York"), "2026-11-18");
  assert.equal(localDate(lateNight, "Asia/Kolkata"), "2026-11-19");
  assert.equal(localDate(lateNight, "Not/AZone"), "2026-11-19");
  assert.equal(localDate(lateNight, null), "2026-11-19");
  const plan = planPurchase({ amount: "$5.10", merchant: "Starbucks" }, ctx, "2026-11-18");
  assert.ok(!("error" in plan));
  assert.equal(purchaseMessage(plan, "USD", false), "Logged $5.10 at Starbucks · Coffee");
  assert.equal(purchaseMessage(plan, "USD", true), "Already logged $5.10 at Starbucks");
});
