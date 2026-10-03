/**
 * Bank CSV import for the personal ledger, plus recurring-charge detection.
 * Pure functions only: no DOM, no async, no floating point money.
 * Every bank exports differently, so parsing is tolerant, but anything ambiguous
 * is reported (null / row error) instead of being silently guessed wrong.
 */
import { DEFAULT_CATEGORIES, FINANCE_MAX_CENTS } from "./finance-types.ts";
import type { FinanceTransaction, SubscriptionCycle, TxKind } from "./finance-types.ts";

/* ====================================================================== */
/* CSV parsing                                                            */
/* ====================================================================== */

const DELIMITERS = [",", ";", "\t"] as const;

function parseWithDelimiter(text: string, delimiter: string, maxRecords = Infinity): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  // True once the current field has had a quoted section; later quotes in it are literal.
  let wasQuoted = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    record.push(wasQuoted ? field.replace(/[ \t]+$/, "") : field);
    field = "";
    wasQuoted = false;
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    // An opening quote is honored at field start, tolerating leading spaces (`a, "b, c"`).
    if (ch === '"' && !wasQuoted && field.trim() === "") {
      field = "";
      inQuotes = true;
      wasQuoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endField();
      records.push(record);
      if (records.length >= maxRecords) return records;
      record = [];
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || record.length > 0 || wasQuoted) {
    endField();
    records.push(record);
  }
  return records;
}

function isEmptyRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

function delimiterScore(text: string, delimiter: string): { consistent: number; columns: number } {
  const sample = parseWithDelimiter(text, delimiter, 30).filter((row) => !isEmptyRow(row));
  const counts = new Map<number, number>();
  for (const row of sample) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let bestColumns = 1;
  let bestCount = 0;
  for (const [columns, count] of counts) {
    if (columns < 2) continue;
    if (count > bestCount || (count === bestCount && columns > bestColumns)) {
      bestColumns = columns;
      bestCount = count;
    }
  }
  return { consistent: bestCount, columns: bestColumns };
}

/** Detects , ; or tab by which gives the most rows with one consistent (>= 2) column count. */
export function detectDelimiter(text: string): string {
  let best: string = ",";
  let bestScore = { consistent: -1, columns: 0 };
  for (const delimiter of DELIMITERS) {
    const score = delimiterScore(text, delimiter);
    if (
      score.consistent > bestScore.consistent ||
      (score.consistent === bestScore.consistent && score.columns > bestScore.columns)
    ) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180 parser with BOM stripping, CRLF/LF support, and delimiter auto-detection. */
export function parseCsv(text: string): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (clean.trim() === "") return [];
  const delimiter = detectDelimiter(clean);
  return parseWithDelimiter(clean, delimiter).filter((row) => !isEmptyRow(row));
}

/* ====================================================================== */
/* Column detection                                                       */
/* ====================================================================== */

export type ColumnMapping = {
  date: number;
  /** -1 when the file has no recognizable description column. */
  description: number;
  amount: number | null;
  debit: number | null;
  credit: number | null;
  category: number | null;
};

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Lower index = stronger preference.
const DATE_HEADERS = [
  "transaction date", "trans date", "txn date", "date", "date of transaction", "booking date", "value date",
  "datum", "fecha", "buchungstag", "post date", "posted date", "posting date", "settlement date",
];
const DESCRIPTION_HEADERS = [
  "description", "transaction description", "original description", "name", "payee", "merchant", "merchant name",
  "details", "transaction details", "narrative", "particulars", "omschrijving", "beschreibung", "concepto", "libelle",
  "memo",
];
const AMOUNT_HEADERS = ["amount", "transaction amount", "amt", "value", "bedrag", "betrag", "importe", "montant", "net amount"];
const DEBIT_HEADERS = ["debit", "debits", "debit amount", "withdrawal", "withdrawals", "withdrawal amount", "money out", "paid out", "outflow", "amount out"];
const CREDIT_HEADERS = ["credit", "credits", "credit amount", "deposit", "deposits", "deposit amount", "money in", "paid in", "inflow", "amount in"];
const CATEGORY_HEADERS = ["category", "transaction category", "categorie", "kategorie"];

function findColumn(normalized: string[], names: readonly string[], used: Set<number>): number | null {
  let best: number | null = null;
  let bestRank = Infinity;
  normalized.forEach((cell, index) => {
    if (used.has(index)) return;
    const rank = names.indexOf(cell);
    if (rank >= 0 && rank < bestRank) {
      best = index;
      bestRank = rank;
    }
  });
  return best;
}

function mappingForRow(row: string[]): { mapping: ColumnMapping | null; score: number } {
  const normalized = row.map(normalizeHeader);
  const used = new Set<number>();
  const date = findColumn(normalized, DATE_HEADERS, used);
  if (date !== null) used.add(date);
  const amount = findColumn(normalized, AMOUNT_HEADERS, used);
  if (amount !== null) used.add(amount);
  const debit = findColumn(normalized, DEBIT_HEADERS, used);
  if (debit !== null) used.add(debit);
  const credit = findColumn(normalized, CREDIT_HEADERS, used);
  if (credit !== null) used.add(credit);
  const description = findColumn(normalized, DESCRIPTION_HEADERS, used);
  if (description !== null) used.add(description);
  const category = findColumn(normalized, CATEGORY_HEADERS, used);
  const score =
    (date !== null ? 4 : 0) +
    (amount !== null || debit !== null || credit !== null ? 4 : 0) +
    (description !== null ? 2 : 0) +
    (category !== null ? 1 : 0);
  if (date === null || (amount === null && debit === null && credit === null)) return { mapping: null, score };
  return {
    mapping: { date, description: description ?? -1, amount, debit, credit, category },
    score,
  };
}

/** Finds the header row within the first 10 rows and maps the known columns. */
export function detectColumns(rows: string[][]): { headerRow: number; mapping: ColumnMapping | null; headers: string[] } {
  const limit = Math.min(rows.length, 10);
  let bestRow = -1;
  let bestScore = -1;
  let bestMapping: ColumnMapping | null = null;
  for (let index = 0; index < limit; index += 1) {
    const { mapping, score } = mappingForRow(rows[index]);
    if (mapping && score > bestScore) {
      bestRow = index;
      bestScore = score;
      bestMapping = mapping;
    }
  }
  if (bestRow < 0) return { headerRow: 0, mapping: null, headers: (rows[0] ?? []).map((cell) => cell.trim()) };
  return { headerRow: bestRow, mapping: bestMapping, headers: rows[bestRow].map((cell) => cell.trim()) };
}

/* ====================================================================== */
/* Dates                                                                  */
/* ====================================================================== */

export type DateOrder = "MDY" | "DMY" | "YMD";

const NUMERIC_DATE = /^(\d{1,4})([-/.])(\d{1,2})\2(\d{1,4})(?:[T\s].*)?$/;

/** Votes over sample values: first part > 12 means DMY, second > 12 means MDY, 4-digit first part means YMD. */
export function detectDateOrder(values: string[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  let ymd = 0;
  let dotted = 0;
  let slashed = 0;
  for (const raw of values) {
    const match = NUMERIC_DATE.exec(raw.trim());
    if (!match) continue;
    const [, a, sep, b] = match;
    if (a.length === 4) {
      ymd += 1;
      continue;
    }
    if (sep === ".") dotted += 1;
    else slashed += 1;
    const first = Number(a);
    const second = Number(b);
    if (first > 12 && second <= 12) dmy += 1;
    else if (second > 12 && first <= 12) mdy += 1;
  }
  if (dmy > 0 || mdy > 0) return dmy > mdy ? "DMY" : "MDY";
  if (ymd > 0 && dotted === 0 && slashed === 0) return "YMD";
  // Ambiguous: dotted dates (02.10.2026) are a European convention; slashes default to US.
  if (dotted > slashed) return "DMY";
  if (ymd > 0 && slashed === 0) return "YMD";
  return "MDY";
}

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
function formatYmd(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}
function expandYear(text: string): number | null {
  if (text.length === 2) return 2000 + Number(text);
  if (text.length === 4) return Number(text);
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const WEEKDAYS = new Set(["mon", "monday", "tue", "tues", "tuesday", "wed", "wednesday", "thu", "thur", "thurs", "thursday", "fri", "friday", "sat", "saturday", "sun", "sunday"]);

/** Parses common bank date formats to YYYY-MM-DD; null for anything impossible or unrecognized. */
export function parseDate(value: string, order: DateOrder): string | null {
  const text = value.trim();
  if (text === "") return null;

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return formatYmd(Number(compact[1]), Number(compact[2]), Number(compact[3]));

  const numeric = NUMERIC_DATE.exec(text);
  if (numeric) {
    const [, a, , b, c] = numeric;
    if (a.length === 4) {
      if (c.length > 2) return null;
      return formatYmd(Number(a), Number(b), Number(c));
    }
    if (a.length > 2) return null;
    const year = expandYear(c);
    if (year === null) return null;
    if (order === "DMY") return formatYmd(year, Number(b), Number(a));
    return formatYmd(year, Number(a), Number(b));
  }

  // Month-name formats: "Oct 2, 2026", "2 Oct 2026", "October 2 2026", "02-Oct-2026", "Fri, Oct 2, 2026".
  const tokens = text
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .split(/[\s,.\-/]+/)
    .filter((token) => token !== "" && !WEEKDAYS.has(token));
  if (tokens.length !== 3) return null;
  const monthIndex = tokens.findIndex((token) => MONTHS[token] !== undefined);
  if (monthIndex < 0) return null;
  const month = MONTHS[tokens[monthIndex]];
  const rest = tokens.filter((_, index) => index !== monthIndex);
  if (!rest.every((token) => /^\d+$/.test(token))) return null;
  let day: string;
  let yearText: string;
  if (monthIndex === 0 || monthIndex === 1) {
    // Month first ("Oct 2 2026") or day first ("2 Oct 2026"): remaining are [day, year].
    [day, yearText] = rest;
  } else {
    return null;
  }
  if (day.length > 2) return null;
  const year = expandYear(yearText);
  if (year === null) return null;
  return formatYmd(year, month, Number(day));
}

/* ====================================================================== */
/* Amounts                                                                */
/* ====================================================================== */

const CURRENCY_SYMBOLS = /[$€£¥₹₩₽¢]/g;
const CURRENCY_CODES = /(?<![A-Z])(?:USD|EUR|GBP|INR|CAD|AUD|NZD|JPY|CHF|MXN|SGD|HKD)(?![A-Z])/g;

function validGroups(groups: string[]): boolean {
  if (groups.length < 2) return true;
  if (!/^\d{1,3}$/.test(groups[0]) || (groups[0].length > 1 && groups[0][0] === "0")) return false;
  return groups.slice(1).every((group) => /^\d{3}$/.test(group));
}

/** Parses a bank amount string into exact signed cents; null for empty, garbage, or out-of-range values. */
export function parseAmountCents(value: string): number | null {
  let text = value.normalize("NFKC").replace(/\u2212/g, "-").trim().toUpperCase();
  if (text === "") return null;
  let negatives = 0;
  let positives = 0;

  const crdr = /^(CR|DR)\.?\s*|\s*(CR|DR)\.?$/;
  const crdrMatch = crdr.exec(text);
  const crdrTag = crdrMatch ? crdrMatch[1] ?? crdrMatch[2] : null;
  if (crdrTag === "DR") negatives += 1;
  if (crdrTag) text = text.replace(crdr, "").trim();

  text = text.replace(/[A-Z]{1,2}\$/g, "$").replace(CURRENCY_CODES, "").replace(CURRENCY_SYMBOLS, "").trim();

  // Signs and parentheses, possibly separated from the number by spaces.
  for (let guard = 0; guard < 4; guard += 1) {
    if (text.startsWith("(") && text.endsWith(")")) {
      negatives += 1;
      text = text.slice(1, -1).trim();
    } else if (text.startsWith("-")) {
      negatives += 1;
      text = text.slice(1).trim();
    } else if (text.endsWith("-")) {
      negatives += 1;
      text = text.slice(0, -1).trim();
    } else if (text.startsWith("+")) {
      positives += 1;
      text = text.slice(1).trim();
    } else if (text.endsWith("+")) {
      positives += 1;
      text = text.slice(0, -1).trim();
    } else break;
  }
  // Conflicting or doubled direction markers ("--5", "CR -5", "-(5)") are ambiguous, not guessed.
  if (negatives > 1 || positives > 1 || (crdrTag === "CR" && negatives > 0) || (crdrTag !== null && positives > 0)) return null;
  if (text === "") return null;

  // Space or apostrophe thousands separators must form proper groups of three.
  if (/[\s']/.test(text)) {
    if (!/^\d{1,3}(?:[\s']\d{3})+(?:[.,]\d*)?$/.test(text)) return null;
    text = text.replace(/[\s']/g, "");
  }
  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return null;

  let integerPart: string;
  let fraction = "";
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  const dots = text.split(".").length - 1;
  const commas = text.split(",").length - 1;
  if (dots > 0 && commas > 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    const decimalIndex = Math.max(lastDot, lastComma);
    if (text.split(decimal).length - 1 !== 1) return null;
    const head = text.slice(0, decimalIndex);
    if (head.includes(decimal)) return null;
    const groups = head.split(thousands);
    if (!validGroups(groups)) return null;
    integerPart = groups.join("");
    fraction = text.slice(decimalIndex + 1);
  } else if (dots + commas > 0) {
    const sep = dots > 0 ? "." : ",";
    const count = dots + commas;
    const parts = text.split(sep);
    if (count > 1) {
      if (!validGroups(parts)) return null;
      integerPart = parts.join("");
    } else {
      const [head, tail] = parts;
      // A single comma followed by exactly three digits reads as a US thousands separator ("1,234");
      // a single dot is always a decimal point ("12.505" rounds to 12.51).
      if (sep === "," && tail.length === 3 && head !== "" && head !== "0" && validGroups([head, tail])) {
        integerPart = head + tail;
      } else {
        integerPart = head;
        fraction = tail;
      }
    }
  } else {
    integerPart = text;
  }
  if (!/^\d*$/.test(integerPart) || !/^\d*$/.test(fraction)) return null;
  if (integerPart === "" && fraction === "") return null;

  const fracPadded = (fraction + "000").slice(0, 3);
  let cents = BigInt(integerPart === "" ? "0" : integerPart) * 100n + BigInt(fracPadded.slice(0, 2));
  if (Number(fracPadded[2]) >= 5) cents += 1n;
  if (cents > BigInt(FINANCE_MAX_CENTS)) return null;
  if (cents === 0n) return 0;
  return Number(negatives > 0 ? -cents : cents);
}

/* ====================================================================== */
/* Categories and kinds                                                   */
/* ====================================================================== */

const CATEGORY_KEYWORDS: readonly (readonly [string, readonly string[]])[] = [
  ["Housing", ["rent", "rent payment", "landlord", "mortgage", "apartment*", "property mgmt", "property management", "hoa", "hoa dues"]],
  ["Groceries", [
    "costco", "whole foods", "wholefds", "trader joe*", "grocery", "groceries", "walmart grocery", "instacart", "aldi",
    "shoprite", "stop & shop", "h mart", "patel brothers", "patel bros", "safeway", "kroger", "wegmans", "fresh direct",
    "freshdirect", "supermarket",
  ]],
  ["Utilities", [
    "con ed", "con edison", "pseg", "pse&g", "electric", "power", "gas & electric", "water", "utility", "utilities",
    "comcast", "xfinity", "verizon", "t-mobile", "at&t", "optimum", "spectrum", "internet",
  ]],
  ["Transport", [
    "uber", "lyft", "mta", "path", "nj transit", "njtransit", "amtrak", "shell", "exxon", "exxonmobil", "mobil", "bp",
    "chevron", "sunoco", "gas station", "parking", "toll", "tolls", "e-zpass", "ezpass", "citi bike", "citibike",
  ]],
  ["Health", [
    "cvs", "walgreens", "rite aid", "pharmacy", "doctor", "dental", "dentist", "hospital", "clinic", "urgent care",
    "gym", "equinox", "planet fitness", "blink fitness",
  ]],
  ["Debt payments", ["student loan", "navient", "nelnet", "sallie mae", "mohela", "loan payment", "affirm", "klarna"]],
  ["Dining", [
    "doordash", "uber eats", "ubereats", "grubhub", "seamless", "chipotle", "starbucks", "dunkin", "mcdonald*",
    "restaurant*", "cafe", "coffee", "pizza*", "diner", "sweetgreen", "shake shack",
  ]],
  ["Shopping", [
    "amazon", "amzn*", "amazon.com", "target", "best buy", "bestbuy", "apple store", "nike", "uniqlo", "zara", "ebay",
    "etsy", "ikea", "walmart",
  ]],
  ["Subscriptions", [
    "netflix", "spotify", "apple.com/bill", "hulu", "youtube premium", "youtube tv", "youtubepremium", "disney+",
    "disney plus", "hbo max", "max.com", "paramount+", "paramount plus", "paramount", "prime video", "amazon prime",
    "audible", "icloud", "chatgpt", "openai", "anthropic", "claude.ai", "cursor", "github", "notion", "adobe", "dropbox",
  ]],
  ["Entertainment", ["amc", "regal", "ticketmaster", "stubhub", "steam", "steamgames", "playstation", "xbox", "nintendo", "fandango"]],
  ["Travel", [
    "airline*", "delta", "delta air*", "united airlines", "united air*", "united.com", "jetblue", "american airlines",
    "southwest", "airbnb", "hotel*", "marriott", "hilton", "hyatt", "expedia", "booking.com",
  ]],
  ["Investing", ["vanguard", "fidelity", "schwab", "robinhood", "brokerage", "etrade", "e-trade", "wealthfront", "betterment"]],
  ["Savings", ["transfer to savings", "savings transfer", "high yield", "high-yield"]],
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function keywordPattern(keyword: string): RegExp {
  const prefix = keyword.endsWith("*");
  const body = (prefix ? keyword.slice(0, -1) : keyword).replace(/\s*&\s*/g, "&");
  let source = "";
  for (const ch of body) {
    if (ch === " ") source += "[\\s\\-_*]*";
    else if (ch === "&") source += "\\s*(?:&|and)\\s*";
    else if (ch === "-") source += "[\\s\\-]?";
    else source += escapeRegex(ch);
  }
  const last = body[body.length - 1];
  const endGuard = prefix || !/[a-z0-9]/.test(last) ? "" : "(?![a-z0-9])";
  return new RegExp(`(?<![a-z0-9])${source}${endGuard}`);
}

const CATEGORY_MATCHERS: readonly { category: string; keyword: string; pattern: RegExp; weight: number }[] =
  CATEGORY_KEYWORDS.flatMap(([category, keywords]) =>
    keywords.map((keyword) => ({ category, keyword, pattern: keywordPattern(keyword), weight: keyword.replace(/[^a-z0-9]/g, "").length })),
  );

const CATEGORY_HINTS: readonly (readonly [RegExp, string])[] = [
  [/food|drink|dining|restaurant/, "Dining"],
  [/grocer/, "Groceries"],
  [/gas|fuel|auto|transport|travel.*commut|parking/, "Transport"],
  [/bill|utilit/, "Utilities"],
  [/health|medical|pharm|fitness|personal care/, "Health"],
  [/shop|merchandise|clothing/, "Shopping"],
  [/entertain/, "Entertainment"],
  [/travel|airline|lodging|hotel/, "Travel"],
  [/rent|mortgage|housing/, "Housing"],
  [/subscript/, "Subscriptions"],
];

function normalizeForMatch(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Guesses one of DEFAULT_CATEGORIES' names for an expense from its description.
 * The longest matching keyword wins (so "uber eats" beats "uber", "prime video" beats "amazon").
 * `hint` is an optional bank-provided category label used only when no keyword matches.
 */
export function guessCategoryName(description: string, kind: TxKind, hint?: string | null): string | null {
  if (kind !== "expense") return null;
  const text = normalizeForMatch(description);
  let best: { category: string; weight: number } | null = null;
  for (const matcher of CATEGORY_MATCHERS) {
    if (matcher.pattern.test(text) && (best === null || matcher.weight > best.weight)) {
      best = { category: matcher.category, weight: matcher.weight };
    }
  }
  if (best) return best.category;
  if (hint) {
    const h = normalizeForMatch(hint);
    const exact = DEFAULT_CATEGORIES.find((category) => category.name.toLowerCase() === h);
    if (exact) return exact.name;
    for (const [pattern, category] of CATEGORY_HINTS) if (pattern.test(h)) return category;
  }
  return null;
}

const TRANSFER_PATTERNS: readonly RegExp[] = [
  /\bcredit card (?:payment|pmt)\b/,
  /\bpayment[\s\-]*thank you\b/,
  /\bthank you for your payment\b/,
  /\bautopay (?:payment|pmt)\b/,
  /\bautomatic payment\b.*\bthank you\b/,
  /\bcard payment\b/,
  /\bonline (?:banking )?transfer (?:to|from)\b/,
  /\btransfer (?:to|from) (?:my )?(?:checking|savings|account|acct|brokerage|chk|sav)\b/,
  /\b(?:internal|account) transfer\b/,
];

/** Expense/income by sign, except own-money movements (card payments, account transfers) which are transfers. */
export function classifyKind(description: string, signedCents: number): TxKind {
  const text = normalizeForMatch(description).replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ");
  if (TRANSFER_PATTERNS.some((pattern) => pattern.test(text))) return "transfer";
  return signedCents > 0 ? "income" : "expense";
}

/* ====================================================================== */
/* Fingerprints                                                           */
/* ====================================================================== */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a over the UTF-8 bytes of `text`, as 16 lowercase hex chars. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizeDescriptionKey(description: string): string {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}

export function csvFingerprint(parts: {
  accountId: string | null;
  date: string;
  amountCents: number;
  kind: TxKind;
  description: string;
  occurrence: number;
}): string {
  const payload = [
    parts.accountId ?? "",
    parts.date,
    String(parts.amountCents),
    parts.kind,
    normalizeDescriptionKey(parts.description),
    String(parts.occurrence),
  ].join("\u001f");
  return `csv:${fnv1a64(payload)}`;
}

/* ====================================================================== */
/* Import rows                                                            */
/* ====================================================================== */

export type ImportPreviewRow = {
  /** 1-based index into the parsed (non-empty) CSV rows. */
  line: number;
  date: string;
  description: string;
  amount_cents: number;
  kind: TxKind;
  category_name: string | null;
  external_id: string;
  error: string | null;
};

export const IMPORT_DESCRIPTION_MAX = 140;
const FALLBACK_DESCRIPTION = "Imported transaction";

function cell(row: string[], index: number | null): string {
  if (index === null || index < 0 || index >= row.length) return "";
  return row[index].trim();
}

export function buildImportRows(
  rows: string[][],
  options: { headerRow: number; mapping: ColumnMapping; dateOrder: DateOrder; invertSigns: boolean; accountId: string | null },
): ImportPreviewRow[] {
  const { mapping } = options;
  const occurrences = new Map<string, number>();
  const out: ImportPreviewRow[] = [];
  for (let index = options.headerRow + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const rawDescription = cell(row, mapping.description).replace(/\s+/g, " ");
    const description = (rawDescription === "" ? FALLBACK_DESCRIPTION : rawDescription).slice(0, IMPORT_DESCRIPTION_MAX).trim();
    const base: ImportPreviewRow = {
      line: index + 1,
      date: "",
      description,
      amount_cents: 0,
      kind: "expense",
      category_name: null,
      external_id: "",
      error: null,
    };

    const rawDate = cell(row, mapping.date);
    const date = parseDate(rawDate, options.dateOrder);
    if (date === null) {
      out.push({ ...base, error: rawDate === "" ? "Missing date" : `Unrecognized date "${rawDate.slice(0, 40)}"` });
      continue;
    }
    base.date = date;

    let signed: number | null = null;
    let amountError: string | null = null;
    if (mapping.amount !== null) {
      const raw = cell(row, mapping.amount);
      if (raw === "") amountError = "Missing amount";
      else {
        signed = parseAmountCents(raw);
        if (signed === null) amountError = `Unrecognized amount "${raw.slice(0, 40)}"`;
        else if (options.invertSigns && signed !== 0) signed = -signed;
      }
    } else {
      const rawDebit = cell(row, mapping.debit);
      const rawCredit = cell(row, mapping.credit);
      if (rawDebit === "" && rawCredit === "") amountError = "Missing amount";
      else {
        const debit = rawDebit === "" ? 0 : parseAmountCents(rawDebit);
        const credit = rawCredit === "" ? 0 : parseAmountCents(rawCredit);
        if (debit === null) amountError = `Unrecognized debit "${rawDebit.slice(0, 40)}"`;
        else if (credit === null) amountError = `Unrecognized credit "${rawCredit.slice(0, 40)}"`;
        else {
          signed = Math.abs(credit) - Math.abs(debit);
          if (options.invertSigns && signed !== 0) signed = -signed;
        }
      }
    }
    if (amountError !== null || signed === null) {
      out.push({ ...base, error: amountError ?? "Missing amount" });
      continue;
    }
    if (signed === 0) {
      out.push({ ...base, error: "Zero amount" });
      continue;
    }

    const amount = Math.abs(signed);
    const kind = classifyKind(description, signed);
    const hint = mapping.category !== null ? cell(row, mapping.category) : null;
    const category_name = kind === "expense" ? guessCategoryName(description, kind, hint) : null;
    const dedupeKey = [date, amount, kind, normalizeDescriptionKey(description)].join("\u001f");
    const occurrence = occurrences.get(dedupeKey) ?? 0;
    occurrences.set(dedupeKey, occurrence + 1);
    out.push({
      ...base,
      amount_cents: amount,
      kind,
      category_name,
      external_id: csvFingerprint({ accountId: options.accountId, date, amountCents: amount, kind, description, occurrence }),
    });
  }
  return out;
}

/* ====================================================================== */
/* Merchant normalization and recurring detection                         */
/* ====================================================================== */

const NOISE_PHRASES: readonly RegExp[] = [
  /\bdebit card purchase\b/g,
  /\bpurchase authorized on\b/g,
  /\bauthorized on\b/g,
  /\bcard purchase(?: with pin)?\b/g,
  /\bpos (?:purchase|debit|withdrawal)\b/g,
  /\bpos\b/g,
  /\brecurring(?: (?:payment|debit|charge))?\b/g,
  /\bach(?: (?:debit|credit|pmt|payment|withdrawal))?\b/g,
  /\bweb id\b/g,
  /\bcheckcard\b/g,
  /\bpreauthorized\b/g,
  /\bppd\b/g,
  /\bccd\b/g,
  /\bdes\b/g,
  /^(?:sq|tst|pp|sp|pypl|paypal)\s*\*/g,
];

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/** Reduces a bank description to a stable merchant key for grouping (lowercase, max 4 words). */
export function normalizeMerchant(description: string): string {
  let text = description.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  // Case-insensitive noise first, so the original casing survives for the state-code check below.
  text = text
    .replace(/\bweb id\s*:?\s*\S*/gi, " ")
    .replace(/\bindn\s*:.*$/i, " ")
    .replace(/\bco id\s*:.*$/i, " ")
    .replace(/\bid\s*:\s*\S+/gi, " ")
    .replace(/\bcard\s*(?:#|no\.?|ending(?: in)?)?\s*x*\d{2,}/gi, " ")
    .replace(/x{2,}\d+/gi, " ")
    .replace(/\*+\d+/g, " ")
    .replace(/#\s*\d+/g, " ")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ")
    .replace(/\.(?:com|net|org|io|co|ai)\b/gi, " ")
    // Tokens containing digits are store numbers / reference codes ("F1234", "P1A2B3"): drop them whole.
    .replace(/[A-Za-z0-9]*\d[A-Za-z0-9]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Trailing "CITY ST" fragments: drop the 2-letter uppercase state code (only when other text precedes it).
  text = text.replace(/(\S)\s+[A-Z]{2}$/, "$1");
  text = text.toLowerCase();
  for (const phrase of NOISE_PHRASES) text = text.replace(phrase, " ").trim();
  text = text.replace(/'/g, "").replace(/[^a-z\s]+/g, " ").replace(/\s+/g, " ").trim();
  for (const phrase of NOISE_PHRASES) text = text.replace(phrase, " ").trim();
  const words = text.split(/\s+/).filter((word) => word !== "" && word !== "on" && word !== "id");
  return words.slice(0, 4).join(" ");
}

export type RecurringSuggestion = {
  key: string;
  name: string;
  amount_cents: number;
  cycle: SubscriptionCycle;
  anchor_date: string;
  next_date: string;
  occurrences: number;
  confidence: "high" | "medium";
};

const CYCLE_RANGES: readonly { cycle: SubscriptionCycle; min: number; max: number; nominal: number }[] = [
  { cycle: "weekly", min: 6, max: 8, nominal: 7 },
  { cycle: "monthly", min: 26, max: 35, nominal: 30 },
  { cycle: "quarterly", min: 84, max: 98, nominal: 91 },
  { cycle: "yearly", min: 350, max: 380, nominal: 365 },
];

function isoParts(value: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return formatYmd(y, m, d) === null ? null : [y, m, d];
}

function dayNumber(value: string): number | null {
  const parts = isoParts(value);
  if (!parts) return null;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86_400_000;
}

function fromDayNumber(days: number): string {
  const date = new Date(days * 86_400_000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Adds whole months, clamping to month end (Jan 31 + 1 month = Feb 28/29). `preferredDay` restores e.g. the 31st. */
export function addMonthsClamped(value: string, months: number, preferredDay?: number): string {
  const parts = isoParts(value);
  if (!parts) return value;
  const total = parts[0] * 12 + (parts[1] - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(preferredDay ?? parts[2], daysInMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function addCycle(value: string, cycle: SubscriptionCycle, preferredDay?: number): string {
  if (cycle === "weekly") {
    const days = dayNumber(value);
    return days === null ? value : fromDayNumber(days + 7);
  }
  const months = cycle === "monthly" ? 1 : cycle === "quarterly" ? 3 : 12;
  return addMonthsClamped(value, months, preferredDay);
}

function median(sorted: readonly number[]): number {
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function detectRecurring(
  transactions: Pick<FinanceTransaction, "date" | "description" | "amount_cents" | "kind" | "subscription_id">[],
  today: string,
  existingSubscriptionNames: string[],
): RecurringSuggestion[] {
  const todayNumber = dayNumber(today);
  if (todayNumber === null) return [];
  const existing = existingSubscriptionNames.map(normalizeMerchant).filter((name) => name !== "");

  const groups = new Map<string, { date: string; day: number; amount: number }[]>();
  for (const tx of transactions) {
    if (tx.kind !== "expense" || tx.subscription_id) continue;
    if (!Number.isSafeInteger(tx.amount_cents) || tx.amount_cents <= 0) continue;
    const day = dayNumber(tx.date);
    if (day === null) continue;
    const key = normalizeMerchant(tx.description);
    if (key === "") continue;
    const list = groups.get(key) ?? [];
    list.push({ date: tx.date, day, amount: tx.amount_cents });
    groups.set(key, list);
  }

  const suggestions: RecurringSuggestion[] = [];
  for (const [key, charges] of groups) {
    if (existing.some((name) => name.includes(key) || key.includes(name))) continue;
    charges.sort((a, b) => a.day - b.day);
    if (charges.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < charges.length; i += 1) gaps.push(charges[i].day - charges[i - 1].day);
    const medianGap = median([...gaps].sort((a, b) => a - b));
    const range = CYCLE_RANGES.find((candidate) => medianGap >= candidate.min && medianGap <= candidate.max);
    if (!range) continue;
    const minimum = range.cycle === "yearly" ? 2 : 3;
    if (charges.length < minimum) continue;
    const outliers = gaps.filter((gap) => gap < range.min || gap > range.max).length;
    if (outliers > 1) continue;

    const medianAmount = median(charges.map((charge) => charge.amount).sort((a, b) => a - b));
    const amountsOk = charges.every((charge) => {
      const diff = Math.abs(charge.amount - medianAmount);
      return diff <= 200 || diff * 100 <= medianAmount * 15;
    });
    if (!amountsOk) continue;

    const latest = charges[charges.length - 1];
    const sinceLatest = todayNumber - latest.day;
    if (sinceLatest * 2 > range.nominal * 3) continue;

    // Keep a 29th/30th/31st billing day when the latest charge was clamped to a shorter month's end.
    let preferredDay: number | undefined;
    if (range.cycle !== "weekly") {
      const [ly, lm, ld] = isoParts(latest.date) as [number, number, number];
      const recentMaxDay = Math.max(...charges.slice(-4).map((charge) => Number(charge.date.slice(8, 10))));
      preferredDay = ld === daysInMonth(ly, lm) && recentMaxDay > ld ? recentMaxDay : ld;
    }

    suggestions.push({
      key,
      name: titleCase(key),
      amount_cents: latest.amount,
      cycle: range.cycle,
      anchor_date: latest.date,
      next_date: addCycle(latest.date, range.cycle, preferredDay),
      occurrences: charges.length,
      confidence: charges.length >= 4 && outliers === 0 ? "high" : "medium",
    });
  }
  suggestions.sort((a, b) => (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : a.name.localeCompare(b.name)));
  return suggestions;
}
