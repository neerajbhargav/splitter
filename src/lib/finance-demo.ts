/**
 * Fictional sample workspace for "Explore with sample data" and screenshots.
 * Every name, institution and number here is made up. Deterministic for a given `today` (seeded PRNG, no clock).
 */
import type {
  BudgetLimit,
  BudgetMonth,
  FinanceAccount,
  FinanceBundle,
  FinanceCategory,
  FinanceHolding,
  FinanceSettings,
  FinanceTransaction,
  Subscription,
  SubscriptionCycle,
  SubscriptionStatus,
  TxKind,
  TxSource,
} from "./finance-types.ts";
import { DEFAULT_CATEGORIES } from "./finance-types.ts";
import { addMonths, holdingValueCents, monthKey } from "./finance-insights.ts";
import { addCalendarDays, isValidCalendarDate, renewalDatesInWindow } from "./subscription-planner.ts";

/* ---------------------------------------------------------------- PRNG */

function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- dates */

function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}
function dayOf(month: string, day: number): string {
  return `${month.slice(0, 8)}${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}
function dayNumber(date: string): number {
  return Math.round(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000);
}
function shiftYear(date: string, delta: number): string {
  const y = Number(date.slice(0, 4)) + delta;
  let md = date.slice(5);
  if (md === "02-29") md = "02-28";
  return `${String(y).padStart(4, "0")}-${md}`;
}
function must(value: string | null): string {
  if (value === null) throw new RangeError("Date out of range");
  return value;
}
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* ---------------------------------------------------------------- data */

const PAYROLL_ANCHOR = "2026-01-02"; // a Friday; biweekly pay dates are every 14 days from here
const PAYCHECK_CENTS = 249_231; // $5,400 take-home x 12 / 26
const TAKE_HOME_CENTS = 540_000;

/** Monthly limits by category name. Current month first; earlier months use slight variations. Sums stay under take-home. */
const LIMITS: Record<string, number> = {
  Housing: 185_000,
  Groceries: 52_000,
  Utilities: 23_000,
  Transport: 21_000,
  Health: 12_000,
  "Debt payments": 30_000,
  Dining: 26_000,
  Shopping: 20_000,
  Subscriptions: 6_000,
  Entertainment: 9_000,
  Travel: 10_000,
  Other: 7_500,
  Savings: 60_000,
  Investing: 50_000,
};
const LIMIT_TWEAKS: Record<number, Record<string, number>> = {
  [-1]: { Groceries: 50_000, Dining: 24_000, Travel: 15_000 },
  [-2]: { Groceries: 50_000, Dining: 24_000, Shopping: 25_000, Travel: 0 },
};

const FLEXIBLE: ReadonlySet<string> = new Set(["Groceries", "Transport", "Health", "Shopping", "Entertainment", "Travel", "Other"]);
const GROCERS = ["Greenleaf Market", "Corner Fresh Grocery", "Harvest Basket", "Bayside Foods"];
const DINING = ["Luna Noodle Bar", "Copper Kettle Cafe", "Taqueria Sol", "Bricklane Pizza", "Saffron House", "Morning Ritual Coffee", "Pier 9 Diner"];
const SHOPS = ["Northwind Outfitters", "Pagecraft Books", "Hearth & Home Goods", "Ampere Electronics", "Thread Theory"];
const FUN = ["Starlight Cinema", "Riverside Bowling", "City Comedy Club", "Gallery Night Tickets"];
const RIDES = ["Zipcab ride", "Metro Rideshare", "Bike share day pass"];
const UNCATEGORIZED = ["POS PURCHASE 4471 MKT", "ONLINE PMT REF 88213", "CARD PURCHASE KIOSK 12", "Venmo transfer, roommate"];

type SubSpec = {
  key: string;
  name: string;
  amount: number;
  cycle: SubscriptionCycle;
  status: SubscriptionStatus;
  category: string;
  account: string;
  notes: string;
};
const SUBS: SubSpec[] = [
  { key: "streaming", name: "Streamline TV", amount: 1_799, cycle: "monthly", status: "active", category: "Subscriptions", account: "credit", notes: "Standard plan" },
  { key: "music", name: "Tunebox Music", amount: 1_199, cycle: "monthly", status: "active", category: "Subscriptions", account: "credit", notes: "" },
  { key: "cloud", name: "CloudVault 2 TB", amount: 999, cycle: "monthly", status: "active", category: "Subscriptions", account: "credit", notes: "Photo backup" },
  { key: "gym", name: "Ironworks Gym", amount: 4_900, cycle: "monthly", status: "active", category: "Health", account: "checking", notes: "" },
  { key: "yearly", name: "PhotoPro Editor", amount: 9_999, cycle: "yearly", status: "active", category: "Subscriptions", account: "credit", notes: "Annual plan" },
  { key: "weekly", name: "Morning Brief News", amount: 399, cycle: "weekly", status: "active", category: "Subscriptions", account: "credit", notes: "" },
  { key: "paused", name: "LingoLeap", amount: 1_299, cycle: "monthly", status: "paused", category: "Subscriptions", account: "credit", notes: "Paused until spring" },
  { key: "canceled", name: "Flickset Plus", amount: 1_549, cycle: "monthly", status: "canceled", category: "Subscriptions", account: "credit", notes: "Canceled, overlapped with Streamline" },
];
const SUB_DAYS: Record<string, number> = { streaming: 6, music: 14, cloud: 22, gym: 3, paused: 9, canceled: 11 };

/**
 * A believable, fully fictional finance workspace whose ledger ends at `today` (YYYY-MM-DD).
 * Same `today` and `userId` always produce a deep-equal bundle.
 */
export function demoBundle(today: string, userId = "demo"): FinanceBundle {
  if (typeof today !== "string" || !isValidCalendarDate(today)) throw new RangeError(`Invalid date: ${String(today)}`);
  const year = Number(today.slice(0, 4));
  if (year < 1901 || year > 2199) throw new RangeError("Sample data supports years 1901 to 2199");

  const rand = mulberry32(hashSeed(`splitter-demo|${today}`));
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  /** Cents in [min, max], nudged off whole dollars so amounts look real. */
  const amt = (min: number, max: number) => {
    const v = int(min, max);
    return v % 100 === 0 ? v + 37 : v;
  };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];

  const current = monthKey(today);
  const months = [addMonths(current, -2), addMonths(current, -1), current];
  const start = months[0];
  const stamp = (date: string, hour = 9, minute = 0) =>
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
  const setupStamp = stamp(must(addCalendarDays(start, -1)), 18);

  /* settings */
  const settings: FinanceSettings = {
    user_id: userId,
    currency: "USD",
    monthly_gross_cents: 750_000,
    monthly_net_cents: TAKE_HOME_CENTS,
    housing_cents: 185_000,
    car_cents: 0,
    categories_seeded: true,
    created_at: setupStamp,
    updated_at: setupStamp,
  };

  /* categories */
  const categories: FinanceCategory[] = DEFAULT_CATEGORIES.map((c, i) => ({
    id: `demo-cat-${slug(c.name)}`,
    user_id: userId,
    name: c.name,
    kind: c.kind,
    sort: i,
    archived: false,
    created_at: setupStamp,
    updated_at: setupStamp,
  }));
  const catId = (name: string) => `demo-cat-${slug(name)}`;

  /* accounts + holdings */
  const holdingsSpec = [
    { symbol: "VTI", name: "Total Stock Market ETF", shares: "38.4215", price: 28_714 },
    { symbol: "VXUS", name: "Total International Stock ETF", shares: "71.0832", price: 6_437 },
    { symbol: "BND", name: "Total Bond Market ETF", shares: "52.5", price: 7_281 },
  ];
  const holdings: FinanceHolding[] = holdingsSpec.map((h) => ({
    id: `demo-hold-${h.symbol.toLowerCase()}`,
    user_id: userId,
    account_id: "demo-acct-brokerage",
    symbol: h.symbol,
    name: h.name,
    shares: h.shares,
    price_cents: h.price,
    created_at: setupStamp,
    updated_at: stamp(today, 8),
  }));
  const brokerageValue = holdings.reduce((sum, h) => sum + holdingValueCents(h.shares, h.price_cents), 0);
  const account = (key: string, extra: Omit<Partial<FinanceAccount>, "id"> & Pick<FinanceAccount, "name" | "institution" | "type" | "balance_cents" | "last4">): FinanceAccount => ({
    id: `demo-acct-${key}`,
    user_id: userId,
    apr_bps: null,
    minimum_cents: null,
    in_payoff: false,
    source: "manual",
    connection_id: null,
    created_at: setupStamp,
    updated_at: stamp(today, 8),
    ...extra,
  });
  const accounts: FinanceAccount[] = [
    account("checking", { name: "Everyday Checking", institution: "Harbor Federal (sample)", type: "checking", balance_cents: 182_437, last4: "0101" }),
    account("savings", { name: "High-Yield Savings", institution: "Northlight Bank (sample)", type: "savings", balance_cents: 621_890, last4: "0202" }),
    account("brokerage", { name: "Brokerage", institution: "Meridian Invest (sample)", type: "investment", balance_cents: brokerageValue, last4: "0303" }),
    account("credit", { name: "Rewards Card", institution: "Copperline Card (sample)", type: "credit", balance_cents: 213_466, last4: "0404", apr_bps: 2_499, minimum_cents: 6_500, in_payoff: true }),
    account("student-loan", { name: "Student Loan", institution: "Keystone Loan Servicing (sample)", type: "loan", balance_cents: 1_481_250, last4: "0505", apr_bps: 550, minimum_cents: 18_000, in_payoff: true }),
  ];
  const acct = (key: string) => `demo-acct-${key}`;

  /* subscriptions */
  const anchorMonth = addMonths(current, -8);
  const anchors: Record<string, string> = {};
  for (const s of SUBS) {
    if (s.cycle === "monthly") anchors[s.key] = dayOf(anchorMonth, SUB_DAYS[s.key]);
    else if (s.cycle === "yearly") anchors[s.key] = shiftYear(must(addCalendarDays(today, 18)), -1); // renews in 18 days
    else anchors[s.key] = must(addCalendarDays(start, -(37 + int(0, 6)))); // weekly, any weekday
  }
  const subscriptions: Subscription[] = SUBS.map((s) => ({
    id: `demo-sub-${s.key}`,
    user_id: userId,
    name: s.name,
    amount_cents: s.amount,
    cycle: s.cycle,
    anchor_date: anchors[s.key],
    status: s.status,
    notes: s.notes,
    category_id: catId(s.category),
    account_id: acct(s.account),
    created_at: stamp(anchors[s.key] < start ? anchors[s.key] : start, 12),
    updated_at: stamp(start, 12),
  }));

  /* budgets */
  const budgets: BudgetMonth[] = months.map((month, i) => {
    const offset = i - 2;
    const tweaks = LIMIT_TWEAKS[offset] ?? {};
    const limits: BudgetLimit[] = categories.map((c) => ({ category_id: c.id, limit_cents: tweaks[c.name] ?? LIMITS[c.name] ?? 0 }));
    const created = stamp(must(addCalendarDays(month, -1)), 20);
    return { id: `demo-budget-${month.slice(0, 7)}`, user_id: userId, month, income_cents: TAKE_HOME_CENTS, limits, created_at: created, updated_at: created };
  });
  const currentLimits = new Map(budgets[2].limits.map((l) => [l.category_id, l.limit_cents]));
  const currentUsed = new Map<string, number>();
  const currentDiningLimit = budgets[2].limits.find((l) => l.category_id === catId("Dining"))?.limit_cents ?? 0;

  /* ledger */
  type Draft = { date: string; description: string; amount: number; kind: TxKind; category: string | null; account: string; sub: string | null; source: TxSource };
  const drafts: Draft[] = [];
  const add = (date: string, description: string, amount: number, kind: TxKind, category: string | null, accountKey: string, sub: string | null = null, source: TxSource = "manual") => {
    if (date < start || date > today) return;
    // Keep this month believable: only Dining runs over; flexible spending stops near 90% of its limit.
    if (kind === "expense" && category && source === "manual" && FLEXIBLE.has(category) && date >= current) {
      const id = catId(category);
      const limit = currentLimits.get(id) ?? 0;
      const used = currentUsed.get(id) ?? 0;
      if ((used + amount) * 10 > limit * 9) return;
      currentUsed.set(id, used + amount);
    }
    drafts.push({ date, description, amount, kind, category: category ? catId(category) : null, account: acct(accountKey), sub, source });
  };

  for (const month of months) {
    const isCurrent = month === current;
    const dim = daysInMonth(month);
    const d = (day: number) => dayOf(month, day);

    add(d(1), "Rent, Maple Court Apartments", 185_000, "expense", "Housing", "checking");
    add(d(3), "Transfer to High-Yield Savings", 60_000, "expense", "Savings", "checking");
    add(d(2), "Metro monthly transit pass", 13_250, "expense", "Transport", "checking");
    add(d(10), "Keystone student loan payment", 18_000, "expense", "Debt payments", "checking");
    add(d(12), "Bright Grid Electric", amt(6_800, 11_200), "expense", "Utilities", "checking");
    add(d(18), "Fiberlink Internet", 6_499, "expense", "Utilities", "checking");
    add(d(24), "Cellwave Mobile", amt(4_400, 5_100), "expense", "Utilities", "checking");
    add(d(16), "Meridian Invest auto-invest", 50_000, "expense", "Investing", "checking");
    add(d(20), "Payment to Rewards Card", amt(42_000, 61_000), "transfer", null, "checking");
    add(d(int(5, 26)), "Pinewood Pharmacy", amt(1_200, 3_900), "expense", "Health", "credit");
    add(d(int(4, 25)), "Fade & Co Barbers", amt(3_400, 4_600), "expense", "Other", "credit");

    // Groceries every 4 to 6 days.
    for (let day = int(1, 3); day <= dim; day += int(4, 6)) add(d(day), pick(GROCERS), amt(3_800, 14_500), "expense", "Groceries", day % 2 ? "credit" : "checking");
    // Rideshares.
    for (let k = int(2, 4); k > 0; k--) add(d(int(1, dim)), pick(RIDES), amt(900, 3_400), "expense", "Transport", "credit");
    // Shopping and entertainment.
    for (let k = int(2, 4); k > 0; k--) add(d(int(1, dim)), pick(SHOPS), amt(1_800, 9_600), "expense", "Shopping", "credit");
    for (let k = int(1, 2); k > 0; k--) add(d(int(1, dim)), pick(FUN), amt(1_500, 6_000), "expense", "Entertainment", "credit");
    if (month === months[1]) add(d(int(8, 20)), "Coastline Rail tickets", amt(7_200, 11_800), "expense", "Travel", "credit");
    // Uncategorized strays: one in earlier months, one early in the current month.
    add(d(isCurrent ? Math.min(int(1, 5), Number(today.slice(8, 10))) : int(6, 26)), pick(UNCATEGORIZED), amt(1_500, 6_400), "expense", null, "checking");

    // Dining: about twice a week, 14 to 68 dollars. The current month lands a little over its limit.
    if (!isCurrent) {
      for (let day = int(1, 3); day <= dim; day += int(2, 5)) add(d(day), pick(DINING), amt(1_400, 6_800), "expense", "Dining", "credit");
    } else {
      const elapsed = Number(today.slice(8, 10));
      const target = currentDiningLimit + amt(1_800, 4_500);
      const pieces = Math.max(Math.ceil(target / 7_000), Math.round((elapsed * 2) / 7) + 1);
      const weights = Array.from({ length: pieces }, () => 60 + int(0, 80));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      let left = target;
      weights.forEach((w, i) => {
        const part = i === pieces - 1 ? left : Math.floor((target * w) / totalWeight);
        left -= part;
        // The last one lands today so the ledger visibly ends at `today` (and shows as pending).
        const day = i === pieces - 1 ? elapsed : Math.max(1, Math.min(elapsed, 1 + Math.floor(((i + rand()) * elapsed) / pieces)));
        add(d(day), pick(DINING), part, "expense", "Dining", "credit");
      });
    }
  }

  // Biweekly payroll.
  const anchorNo = dayNumber(PAYROLL_ANCHOR);
  for (let date = start; date <= today; date = must(addCalendarDays(date, 1))) {
    if ((((dayNumber(date) - anchorNo) % 14) + 14) % 14 === 0) add(date, "Payroll, Brightwater Labs", PAYCHECK_CENTS, "income", null, "checking");
  }

  // Subscription charges on their renewal dates, up to today.
  for (const s of SUBS) {
    const end = s.status === "active" ? today : s.status === "canceled" ? (dayOf(start, daysInMonth(start)) < today ? dayOf(start, daysInMonth(start)) : today) : null;
    if (!end) continue;
    for (const date of renewalDatesInWindow(anchors[s.key], s.cycle, start, end)) {
      add(date, s.name, s.amount, "expense", s.category, s.account, `demo-sub-${s.key}`, "subscription");
    }
  }

  // Stable order: by date, then insertion order; ids and timestamps follow that order.
  const ordered = drafts.map((t, i) => ({ t, i })).sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.i - b.i));
  const perDay = new Map<string, number>();
  const transactions: FinanceTransaction[] = ordered.map(({ t }, index) => {
    const n = perDay.get(t.date) ?? 0;
    perDay.set(t.date, n + 1);
    const created = stamp(t.date, 8 + Math.min(n, 14), (n * 7) % 60);
    return {
      id: `demo-tx-${String(index + 1).padStart(4, "0")}`,
      user_id: userId,
      account_id: t.account,
      date: t.date,
      description: t.description,
      amount_cents: t.amount,
      kind: t.kind,
      category_id: t.kind === "expense" ? t.category : null,
      subscription_id: t.sub,
      source: t.source,
      external_id: null,
      pending: t.date === today && t.account === acct("credit") && t.source === "manual",
      created_at: created,
      updated_at: created,
    };
  });

  return { user_id: userId, settings, accounts, holdings, categories, budgets, transactions, subscriptions, connections: [] };
}
