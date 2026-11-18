// Apple Pay logging: turns what the iPhone Shortcuts "Transaction" automation sends into a ledger row.
// Pure, so tests/purchase-log.test.ts covers every choice it makes.
import { guessCategoryName, normalizeMerchant } from "./finance-import.ts";
import { parseMoney } from "./split.ts";

export type PurchaseContext = {
  currency: string;
  accounts: { id: string; name: string; last4: string | null; type: string }[];
  categories: { id: string; name: string }[];
  /** The user's recent categorized expenses, newest first. */
  history: { description: string; category_id: string; date: string }[];
};

/** What the Shortcut posts. Every field arrives as text from Shortcuts, so all are optional strings. */
export type PurchaseInput = { amount?: unknown; merchant?: unknown; name?: unknown; card?: unknown; date?: unknown };

export type PurchasePlan = {
  row: { date: string; description: string; amount_cents: number; account_id?: string; category_id?: string };
  account: string | null;
  category: string | null;
  /** Why this category: the last one used at this merchant, a keyword guess, or none. */
  how: "history" | "keyword" | null;
};

const text = (v: unknown, max: number) => (typeof v === "string" || typeof v === "number" ? String(v) : "").replace(/\s+/g, " ").trim().slice(0, max);

/** Cents from "$4.75", "4.75", "USD 1,234.50" or "4,75 €". Null when it isn't a positive amount (a refund is negative). */
export function purchaseCents(raw: unknown): number | null {
  let t = text(raw, 40).replace(/[^\d.,-]/g, "");
  if (t.startsWith("-")) return null;
  // A comma followed by exactly two digits at the end is a decimal comma ("4,75", "1.234,50").
  if (/,\d{2}$/.test(t) && !/\.\d{2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  const cents = parseMoney(t);
  return cents !== null && cents > 0 ? cents : null;
}

/** YYYY-MM-DD for `now` in an IANA time zone, falling back to UTC for a missing or unknown zone. */
export function localDate(now: Date, timeZone: string | null | undefined): string {
  try {
    if (timeZone) return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch { /* unknown zone */ }
  return now.toISOString().slice(0, 10);
}

/** The account a Wallet card name points at: same name, then its last 4 digits, then one unique partial match. */
export function matchAccount(card: string, accounts: PurchaseContext["accounts"]): PurchaseContext["accounts"][number] | null {
  const c = card.toLowerCase().trim();
  if (!c) return null;
  const exact = accounts.find((a) => a.name.toLowerCase().trim() === c);
  if (exact) return exact;
  const digits: string[] = c.match(/\d{4}/g) ?? [];
  const byLast4 = accounts.filter((a) => a.last4 && digits.includes(a.last4.toLowerCase()));
  if (byLast4.length === 1) return byLast4[0];
  const partial = accounts.filter((a) => {
    const n = a.name.toLowerCase().trim();
    return n.length >= 3 && (c.includes(n) || n.includes(c));
  });
  return partial.length === 1 ? partial[0] : null;
}

// Words a bank statement adds after a merchant's name: store numbers, locations, legal suffixes.
const STATEMENT_NOISE = /^(\d+|#\d*|store|shop|location|inc|llc|ltd|co|corp|online|www|com|pos|purchase|[a-z]{2})$/;

/**
 * Wallet sends clean names ("Starbucks") while bank imports look like "STARBUCKS STORE #1234 NEW YORK NY".
 * Two normalized names are the same merchant when they are equal, or when one starts the other and what
 * follows looks like statement noise (a store number, a city and state). "Uber" is not "Uber Eats".
 */
export function sameMerchant(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4 || !long.startsWith(short + " ")) return false;
  const rest = long.slice(short.length + 1).split(" ").filter(Boolean);
  return rest.length >= 2 || rest.every((w) => STATEMENT_NOISE.test(w));
}

export function planPurchase(input: PurchaseInput, ctx: PurchaseContext, today: string): PurchasePlan | { error: string } {
  const amount_cents = purchaseCents(input.amount);
  if (amount_cents === null) {
    return { error: /^\s*-/.test(text(input.amount, 40)) ? "Refunds aren't logged. Add it as income in Activity if you want it counted." : "The Shortcut sent no amount. Check that Amount is in the request body." };
  }
  const card = text(input.card, 100);
  const description = text(input.merchant, 140) || text(input.name, 140) || (card ? `Apple Pay · ${card}`.slice(0, 140) : "Apple Pay purchase");
  const sent = text(input.date, 40).slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sent) ? sent : today;

  const account = matchAccount(card, ctx.accounts);
  const key = normalizeMerchant(description);
  const known = new Set(ctx.categories.map((c) => c.id));
  // The newest categorized purchase at the same merchant wins ("Uber Eats" history is a different merchant from "Uber").
  const last = key ? ctx.history.find((h) => known.has(h.category_id) && sameMerchant(normalizeMerchant(h.description), key)) : undefined;
  let category = last ? ctx.categories.find((c) => c.id === last.category_id) ?? null : null;
  let how: PurchasePlan["how"] = category ? "history" : null;
  if (!category) {
    const guess = guessCategoryName(description, "expense")?.toLowerCase();
    category = guess ? ctx.categories.find((c) => c.name.toLowerCase() === guess) ?? null : null;
    if (category) how = "keyword";
  }
  return {
    row: { date, description, amount_cents, ...(account ? { account_id: account.id } : {}), ...(category ? { category_id: category.id } : {}) },
    account: account?.name ?? null,
    category: category?.name ?? null,
    how,
  };
}

/** The one line the Shortcut can show as a notification. */
export function purchaseMessage(plan: PurchasePlan, currency: string, duplicate: boolean): string {
  let money: string;
  try { money = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(plan.row.amount_cents / 100); }
  catch { money = `${(plan.row.amount_cents / 100).toFixed(2)} ${currency}`; }
  if (duplicate) return `Already logged ${money} at ${plan.row.description}`;
  return `Logged ${money} at ${plan.row.description} · ${plan.category ?? "Uncategorized"}`;
}
