import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMonthsClamped,
  buildImportRows,
  classifyKind,
  csvFingerprint,
  detectColumns,
  detectDateOrder,
  detectRecurring,
  fnv1a64,
  guessCategoryName,
  normalizeMerchant,
  parseAmountCents,
  parseCsv,
  parseDate,
  type ColumnMapping,
  type DateOrder,
  type ImportPreviewRow,
} from "../src/lib/finance-import.ts";
import { DEFAULT_CATEGORIES, FINANCE_MAX_CENTS } from "../src/lib/finance-types.ts";
import type { FinanceTransaction, TxKind } from "../src/lib/finance-types.ts";

/* ---------- helpers ---------- */

function importText(text: string, opts: { invertSigns?: boolean; accountId?: string | null } = {}): {
  rows: ImportPreviewRow[];
  mapping: ColumnMapping;
  headerRow: number;
  dateOrder: DateOrder;
} {
  const parsed = parseCsv(text);
  const detected = detectColumns(parsed);
  assert.ok(detected.mapping, "expected a column mapping");
  const mapping = detected.mapping;
  const dateOrder = detectDateOrder(parsed.slice(detected.headerRow + 1).map((row) => row[mapping.date] ?? ""));
  const rows = buildImportRows(parsed, {
    headerRow: detected.headerRow,
    mapping,
    dateOrder,
    invertSigns: opts.invertSigns ?? false,
    accountId: opts.accountId ?? "acct-test",
  });
  return { rows, mapping, headerRow: detected.headerRow, dateOrder };
}

function ok(rows: ImportPreviewRow[]): ImportPreviewRow[] {
  return rows.filter((row) => row.error === null);
}

type Tx = Pick<FinanceTransaction, "date" | "description" | "amount_cents" | "kind" | "subscription_id">;
function tx(date: string, description: string, amount_cents: number, kind: TxKind = "expense", subscription_id: string | null = null): Tx {
  return { date, description, amount_cents, kind, subscription_id };
}
function series(dates: string[], description: string, amounts: number | number[]): Tx[] {
  return dates.map((date, index) => tx(date, description, Array.isArray(amounts) ? amounts[index] : amounts));
}

/* ---------- parseCsv ---------- */

test("parseCsv handles quotes, escaped quotes, embedded commas and newlines", () => {
  const text = 'Date,Description,Amount\n09/01/2026,"Fictional Plumbing ""Pro"", LLC",-120.00\n09/02/2026,"Line one\nline two",-5\n';
  assert.deepEqual(parseCsv(text), [
    ["Date", "Description", "Amount"],
    ["09/01/2026", 'Fictional Plumbing "Pro", LLC', "-120.00"],
    ["09/02/2026", "Line one\nline two", "-5"],
  ]);
});

test("parseCsv strips BOM, handles CRLF, keeps CRLF inside quotes, drops empty rows", () => {
  const text = '\uFEFFDate,Description,Amount\r\n\r\n10/01/2026,"Multi\r\nline",-1.00\r\n,,\r\n10/02/2026,Plain,2.00';
  const rows = parseCsv(text);
  assert.equal(rows[0][0], "Date");
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], "Multi\r\nline");
  assert.deepEqual(rows[2], ["10/02/2026", "Plain", "2.00"]);
});

test("parseCsv auto-detects semicolon and tab delimiters", () => {
  const semi = "Datum;Omschrijving;Bedrag\n15/09/2026;Bakkerij Voorbeeld;-4,50\n16/09/2026;Markt Test;-12,00\n";
  assert.deepEqual(parseCsv(semi)[1], ["15/09/2026", "Bakkerij Voorbeeld", "-4,50"]);
  const tsv = "Date\tDescription\tAmount\n2026-09-01\tCoffee, large\t-4.25\n2026-09-02\tTea\t-3.00\n";
  assert.deepEqual(parseCsv(tsv)[1], ["2026-09-01", "Coffee, large", "-4.25"]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("   \n\n"), []);
});

test("parseCsv tolerates a space before an opening quote", () => {
  assert.deepEqual(parseCsv('a,b,c\n1, "x, y",3\n4,z,6'), [["a", "b", "c"], ["1", "x, y", "3"], ["4", "z", "6"]]);
});

/* ---------- detectColumns ---------- */

test("detectColumns prefers transaction date over posted date and finds Chase columns", () => {
  const rows = parseCsv("Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n09/28/2026,09/29/2026,X,Food & Drink,Sale,-1.00,\n");
  const result = detectColumns(rows);
  assert.equal(result.headerRow, 0);
  assert.deepEqual(result.mapping, { date: 0, description: 2, amount: 5, debit: null, credit: null, category: 3 });
  const reversed = detectColumns([["Posting Date", "Transaction Date", "Details", "Withdrawals", "Deposits", "Balance"]]);
  assert.deepEqual(reversed.mapping, { date: 1, description: 2, amount: null, debit: 3, credit: 4, category: null });
});

test("detectColumns skips preamble rows and ignores balance columns", () => {
  const rows = [
    ["Account Name", "Fictional Checking"],
    ["Account Number", "XXXX0000"],
    ["Date", "Description", "Amount", "Running Bal."],
    ["09/02/2026", "x", "1.00", "2.00"],
  ];
  const result = detectColumns(rows);
  assert.equal(result.headerRow, 2);
  assert.deepEqual(result.headers, ["Date", "Description", "Amount", "Running Bal."]);
  assert.deepEqual(result.mapping, { date: 0, description: 1, amount: 2, debit: null, credit: null, category: null });
});

test("detectColumns returns null mapping without date or money columns", () => {
  assert.equal(detectColumns([["Description", "Amount"], ["x", "1"]]).mapping, null);
  assert.equal(detectColumns([["Date", "Description", "Balance"]]).mapping, null);
  assert.equal(detectColumns([]).mapping, null);
  const late = Array.from({ length: 11 }, () => ["junk", "row"]).concat([["Date", "Description", "Amount"]]);
  assert.equal(detectColumns(late).mapping, null, "header must be within the first 10 rows");
});

test("detectColumns recognizes alias names", () => {
  assert.deepEqual(detectColumns([["Posted Date", "Payee", "Money Out", "Money In"]]).mapping, {
    date: 0, description: 1, amount: null, debit: 2, credit: 3, category: null,
  });
  assert.deepEqual(detectColumns([["Date", "Merchant", "Transaction Amount (USD)"]]).mapping, {
    date: 0, description: 1, amount: 2, debit: null, credit: null, category: null,
  });
  assert.equal(detectColumns([["Date", "Amount"]]).mapping?.description, -1);
});

/* ---------- dates ---------- */

test("detectDateOrder votes on unambiguous components", () => {
  assert.equal(detectDateOrder(["01/02/2026", "13/02/2026"]), "DMY");
  assert.equal(detectDateOrder(["01/02/2026", "02/13/2026"]), "MDY");
  assert.equal(detectDateOrder(["2026-10-02", "2026-10-03"]), "YMD");
  assert.equal(detectDateOrder(["10/02/2026", "10/03/2026"]), "MDY");
  assert.equal(detectDateOrder(["02.10.2026"]), "DMY");
  assert.equal(detectDateOrder([]), "MDY");
});

test("parseDate handles common bank formats", () => {
  const cases: [string, DateOrder, string][] = [
    ["2026-10-02", "MDY", "2026-10-02"],
    ["2026/10/02", "MDY", "2026-10-02"],
    ["10/02/2026", "MDY", "2026-10-02"],
    ["10/2/26", "MDY", "2026-10-02"],
    ["02/10/2026", "DMY", "2026-10-02"],
    ["02.10.2026", "DMY", "2026-10-02"],
    ["Oct 2, 2026", "MDY", "2026-10-02"],
    ["2 Oct 2026", "MDY", "2026-10-02"],
    ["October 2 2026", "DMY", "2026-10-02"],
    ["02-Oct-2026", "MDY", "2026-10-02"],
    ["Fri, Oct 2nd, 2026", "MDY", "2026-10-02"],
    ["2026-10-02T23:59:00-05:00", "MDY", "2026-10-02"],
    ["2026-10-02T13:00:00Z", "DMY", "2026-10-02"],
    ["10/02/2026 13:45", "MDY", "2026-10-02"],
    ["20261002", "MDY", "2026-10-02"],
    ["2028-02-29", "MDY", "2028-02-29"],
    ["10/02/2026", "YMD", "2026-10-02"],
  ];
  for (const [value, order, expected] of cases) assert.equal(parseDate(value, order), expected, value);
});

test("parseDate rejects impossible or out-of-range dates", () => {
  for (const value of ["2026-02-30", "2027-02-29", "13/01/2026", "1899-12-31", "2201-01-01", "", "yesterday", "Oct 32, 2026", "2026-1-1-1", "00/10/2026"]) {
    assert.equal(parseDate(value, "MDY"), null, value);
  }
  assert.equal(parseDate("31/04/2026", "DMY"), null);
});

/* ---------- amounts ---------- */

test("parseAmountCents parses exact signed cents across conventions", () => {
  const cases: [string, number][] = [
    ["$1,234.56", 123456],
    ["-12.50", -1250],
    ["(12.50)", -1250],
    ["12.50-", -1250],
    ["1.234,56", 123456],
    ["1 234,56", 123456],
    ["1\u00a0234,56", 123456],
    ["€12", 1200],
    ["12.5", 1250],
    ["CR 10.00", 1000],
    ["10.00 DR", -1000],
    ["10.00DR", -1000],
    ["+5", 500],
    ["-$12.50", -1250],
    ["$-12.50", -1250],
    ["USD 7.10", 710],
    ["1,234", 123400],
    ["12,5", 1250],
    ["0,125", 13],
    ["1.234.567,89", 123456789],
    ["1,234,567.89", 123456789],
    ["1'234.50", 123450],
    [".99", 99],
    ["12.505", 1251],
    ["12.504", 1250],
    ["-0.005", -1],
    ["0.004", 0],
    ["-0.00", 0],
    ["\u22123.00", -300],
    ["0.1", 10],
  ];
  for (const [value, expected] of cases) assert.equal(parseAmountCents(value), expected, value);
  assert.ok(Object.is(parseAmountCents("-0.00"), 0), "no negative zero");
});

test("parseAmountCents rejects garbage, ambiguity and out-of-range values", () => {
  for (const value of ["", "   ", "abc", "12.34.56", "1,23,4", "--5", "(-5)", "CR -5", "1 23", "$", "5..0", "12a", "1e5"]) {
    assert.equal(parseAmountCents(value), null, value);
  }
  assert.equal(parseAmountCents("10000000000.00"), FINANCE_MAX_CENTS);
  assert.equal(parseAmountCents("10000000000.01"), null);
  assert.equal(parseAmountCents("-99999999999999999999.99"), null);
});

/* ---------- categories & kinds ---------- */

test("guessCategoryName maps keyword families to default category names", () => {
  const names = new Set(DEFAULT_CATEGORIES.map((category) => category.name));
  const cases: [string, string | null][] = [
    ["UBER *TRIP HELP.UBER.COM", "Transport"],
    ["UBER *EATS PENDING", "Dining"],
    ["UBER EATS", "Dining"],
    ["Lyft *Ride Fri 8pm", "Transport"],
    ["SHELL OIL 57444 SAMPLETOWN NJ", "Transport"],
    ["EXXONMOBIL 4433", "Transport"],
    ["E-ZPASS REPLENISH", "Transport"],
    ["WHOLEFDS MKT 10234", "Groceries"],
    ["Whole Foods Market", "Groceries"],
    ["TRADER JOE'S #555", "Groceries"],
    ["STOP & SHOP 0812", "Groceries"],
    ["Stop and Shop", "Groceries"],
    ["WALMART GROCERY", "Groceries"],
    ["WALMART SUPERCENTER", "Shopping"],
    ["PSE&G AUTOPAY", "Utilities"],
    ["CON ED OF NY", "Utilities"],
    ["T-MOBILE AUTO PAY", "Utilities"],
    ["AT&T *BILL", "Utilities"],
    ["HOMESTEAD PROPERTY MGMT RENT", "Housing"],
    ["DELTA DENTAL INS", "Health"],
    ["DELTA AIR 0062345", "Travel"],
    ["CVS/PHARMACY #01234", "Health"],
    ["PLANET FITNESS CLUB FEES", "Health"],
    ["NAVIENT STUDENT LOAN", "Debt payments"],
    ["STARBUCKS STORE 01234", "Dining"],
    ["MCDONALD'S F1234", "Dining"],
    ["Café Sample", "Dining"],
    ["AMZN Mktp US*AB12CD", "Shopping"],
    ["AMAZON PRIME VIDEO", "Subscriptions"],
    ["APPLE.COM/BILL 866-712-7753", "Subscriptions"],
    ["APPLE STORE R123", "Shopping"],
    ["NETFLIX.COM", "Subscriptions"],
    ["CLAUDE.AI SUBSCRIPTION", "Subscriptions"],
    ["DISNEY+ MONTHLY", "Subscriptions"],
    ["STEAMGAMES.COM 4259522", "Entertainment"],
    ["AMC 1234 ONLINE", "Entertainment"],
    ["AIRBNB * HMABCDEF", "Travel"],
    ["BOOKING.COM HOTEL", "Travel"],
    ["VANGUARD BUY INVESTMENT", "Investing"],
    ["Transfer to Savings goal", "Savings"],
    ["BARNES & NOBLE #2345", null],
    ["Pathology Associates", null],
    ["Rental car deposit", null],
    ["Mobile check fee", null],
    ["Some Unknown Merchant", null],
  ];
  for (const [description, expected] of cases) {
    const got = guessCategoryName(description, "expense");
    assert.equal(got, expected, description);
    if (got !== null) assert.ok(names.has(got));
  }
  assert.equal(guessCategoryName("NETFLIX.COM", "income"), null);
  assert.equal(guessCategoryName("NETFLIX.COM", "transfer"), null);
});

test("guessCategoryName uses a bank category only as a fallback hint", () => {
  assert.equal(guessCategoryName("Some Local Place", "expense", "Food & Drink"), "Dining");
  assert.equal(guessCategoryName("Some Local Place", "expense", "Groceries"), "Groceries");
  assert.equal(guessCategoryName("Some Local Place", "expense", "Gas"), "Transport");
  assert.equal(guessCategoryName("UBER *TRIP", "expense", "Food & Drink"), "Transport", "keyword beats hint");
  assert.equal(guessCategoryName("Some Local Place", "expense", "Miscellaneous"), null);
});

test("classifyKind uses sign but treats own-money movements as transfers", () => {
  assert.equal(classifyKind("STARBUCKS", -500), "expense");
  assert.equal(classifyKind("REFUND WIDGET CO", 1200), "income");
  assert.equal(classifyKind("EXAMPLE CORP DES:PAYROLL PPD", 310000), "income");
  assert.equal(classifyKind("Direct Deposit - Salary", 310000), "income");
  for (const description of [
    "Payment Thank You-Mobile",
    "AUTOPAY PAYMENT - THANK YOU",
    "AUTOMATIC PAYMENT - THANK YOU",
    "CREDIT CARD PAYMENT",
    "SAMPLE BANK CARD PAYMENT",
    "Online Transfer to SAV ...1234",
    "ONLINE BANKING TRANSFER FROM CHK 9999",
    "Transfer from Checking",
    "Transfer to brokerage",
    "Internal transfer",
  ]) {
    assert.equal(classifyKind(description, -10000), "transfer", description);
    assert.equal(classifyKind(description, 10000), "transfer", description);
  }
  assert.equal(classifyKind("NAVIENT LOAN PAYMENT", -20000), "expense");
});

/* ---------- fingerprints ---------- */

test("fnv1a64 matches reference vectors", () => {
  assert.equal(fnv1a64(""), "cbf29ce484222325");
  assert.equal(fnv1a64("a"), "af63dc4c8601ec8c");
  assert.equal(fnv1a64("foobar"), "85944171f73967e8");
  assert.match(fnv1a64("café ☕"), /^[0-9a-f]{16}$/);
});

test("csvFingerprint normalizes description and varies with every key part", () => {
  const base = { accountId: "acct-1", date: "2026-09-01", amountCents: 450, kind: "expense" as TxKind, description: "Coffee  Shop", occurrence: 0 };
  const key = csvFingerprint(base);
  assert.match(key, /^csv:[0-9a-f]{16}$/);
  assert.equal(csvFingerprint({ ...base, description: "  coffee shop " }), key);
  const variants = [
    { ...base, accountId: null },
    { ...base, accountId: "acct-2" },
    { ...base, date: "2026-09-02" },
    { ...base, amountCents: 451 },
    { ...base, kind: "income" as TxKind },
    { ...base, description: "Coffee Shops" },
    { ...base, occurrence: 1 },
  ];
  const keys = new Set([key, ...variants.map(csvFingerprint)]);
  assert.equal(keys.size, variants.length + 1);
});

/* ---------- bank fixtures ---------- */

const CHASE = [
  "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
  "09/28/2026,09/29/2026,STARBUCKS STORE 01234,Food & Drink,Sale,-6.45,",
  "09/27/2026,09/28/2026,UBER *EATS PENDING,Food & Drink,Sale,-23.10,",
  "09/26/2026,09/27/2026,UBER *TRIP,Travel,Sale,-18.40,",
  "09/25/2026,09/25/2026,Payment Thank You-Mobile,,Payment,500.00,",
  "09/24/2026,09/25/2026,AMZN Mktp US*AB12CD34,Shopping,Sale,-42.99,",
  '09/23/2026,09/24/2026,"SHAKE SHACK, SAMPLE AVE",Food & Drink,Sale,-15.20,',
  "09/22/2026,09/23/2026,REFUND - WIDGET CO,Shopping,Return,12.00,",
  "09/21/2026,09/22/2026,LOCAL NOODLE SPOT,Food & Drink,Sale,-31.75,",
].join("\n");

test("Chase credit card export imports with exact cents and kinds", () => {
  const { rows, headerRow } = importText(CHASE);
  assert.equal(headerRow, 0);
  assert.equal(rows.length, 8);
  assert.ok(rows.every((row) => row.error === null));
  const summary = rows.map((row) => [row.line, row.date, row.amount_cents, row.kind, row.category_name]);
  assert.deepEqual(summary, [
    [2, "2026-09-28", 645, "expense", "Dining"],
    [3, "2026-09-27", 2310, "expense", "Dining"],
    [4, "2026-09-26", 1840, "expense", "Transport"],
    [5, "2026-09-25", 50000, "transfer", null],
    [6, "2026-09-24", 4299, "expense", "Shopping"],
    [7, "2026-09-23", 1520, "expense", "Dining"],
    [8, "2026-09-22", 1200, "income", null],
    [9, "2026-09-21", 3175, "expense", "Dining"],
  ]);
  assert.equal(rows[5].description, "SHAKE SHACK, SAMPLE AVE");
  assert.equal(rows[7].category_name, "Dining", "bank category hint used when no keyword matches");
});

const BOFA = [
  "Description,,Summary Amt.",
  'Beginning balance as of 09/01/2026,,"2,500.00"',
  'Total credits,,"3,100.00"',
  'Total debits,,"-1,850.25"',
  'Ending balance as of 09/30/2026,,"3,749.75"',
  "",
  "Date,Description,Amount,Running Bal.",
  '09/01/2026,Beginning balance as of 09/01/2026,,"2,500.00"',
  '09/02/2026,"EXAMPLE CORP DES:PAYROLL ID:XXXXX12345 INDN:SAMPLE PERSON CO ID:XXXXX54321 PPD","3,100.00","5,600.00"',
  '09/03/2026,"HOMESTEAD PROPERTY MGMT DES:RENT ID:000123 INDN:SAMPLE PERSON CO ID:999 WEB","-1,200.00","4,400.00"',
  '09/05/2026,"Online Banking transfer to SAV 9999 Confirmation# 0123456789","-500.00","3,900.00"',
  '09/10/2026,"CON ED OF NY DES:INTELL CK ID:111 INDN:SAMPLE PERSON CO ID:222 PPD","-84.37","3,815.63"',
  '09/15/2026,"SHOPRITE SAMPLETOWN NJ 09/14 PURCHASE","-65.88","3,749.75"',
].join("\r\n");

test("Bank of America export with preamble finds the header and flags the balance row", () => {
  const { rows, headerRow } = importText(BOFA);
  assert.equal(headerRow, 5, "blank preamble row is dropped, header is the 6th parsed row");
  assert.equal(rows.length, 6);
  assert.equal(rows[0].error, "Missing amount");
  assert.equal(rows[0].external_id, "");
  assert.equal(rows[0].date, "2026-09-01");
  assert.deepEqual(ok(rows).map((row) => [row.amount_cents, row.kind, row.category_name]), [
    [310000, "income", null],
    [120000, "expense", "Housing"],
    [50000, "transfer", null],
    [8437, "expense", "Utilities"],
    [6588, "expense", "Groceries"],
  ]);
});

const SOFI = [
  "Date,Description,Type,Amount,Current balance,Status",
  "2026-09-01,EXAMPLE EMPLOYER PAYROLL,Direct Deposit,2857.89,3000.00,Posted",
  "2026-09-03,Netflix.com,Debit Card,-15.49,2984.51,Posted",
  "2026-09-04,Transfer to Savings,Transfer,-200.00,2784.51,Posted",
  "2026-09-05,Fictional Deli & Grill,Debit Card,-12.34,2772.17,Pending",
].join("\n");

test("SoFi-like export with ISO dates", () => {
  const { rows, dateOrder } = importText(SOFI);
  assert.equal(dateOrder, "YMD");
  assert.deepEqual(rows.map((row) => [row.date, row.amount_cents, row.kind, row.category_name]), [
    ["2026-09-01", 285789, "income", null],
    ["2026-09-03", 1549, "expense", "Subscriptions"],
    ["2026-09-04", 20000, "transfer", null],
    ["2026-09-05", 1234, "expense", null],
  ]);
});

const AMEX = [
  "Date,Description,Amount",
  "09/14/2026,NETFLIX.COM LOS GATOS CA,15.49",
  "09/18/2026,FICTIONAL BISTRO SAMPLETOWN NJ,84.20",
  "09/20/2026,AUTOPAY PAYMENT - THANK YOU,-250.00",
  "09/21/2026,CREDIT ADJUSTMENT SAMPLE STORE,-19.99",
].join("\n");

test("Amex export needs invertSigns because charges are positive", () => {
  const inverted = importText(AMEX, { invertSigns: true }).rows;
  assert.deepEqual(inverted.map((row) => [row.amount_cents, row.kind]), [
    [1549, "expense"],
    [8420, "expense"],
    [25000, "transfer"],
    [1999, "income"],
  ]);
  const raw = importText(AMEX, { invertSigns: false }).rows;
  assert.equal(raw[0].kind, "income", "without inversion the charge would read as income");
  assert.notEqual(raw[0].external_id, inverted[0].external_id);
});

const DEBIT_CREDIT = [
  "Posting Date,Transaction Date,Details,Withdrawals,Deposits,Balance",
  "10/01/2026,09/30/2026,TRADER JOE'S #555,54.21,,945.79",
  "10/01/2026,09/30/2026,EXAMPLE EMPLOYER PAYROLL,,1500.00,2445.79",
  "10/02/2026,10/01/2026,ADJUSTED FEE,10.00,2.50,2438.29",
  "10/02/2026,10/01/2026,NEGATIVE STYLE WITHDRAWAL,-20.00,,2418.29",
  "10/03/2026,10/02/2026,EMPTY ROW AMOUNTS,,,2418.29",
  "10/03/2026,10/02/2026,BAD AMOUNT,12.3.4,,2418.29",
].join("\n");

test("debit/credit two-column bank uses transaction date and credit minus debit", () => {
  const { rows, mapping } = importText(DEBIT_CREDIT);
  assert.equal(mapping.date, 1);
  assert.deepEqual(rows.map((row) => [row.date, row.amount_cents, row.kind, row.error]), [
    ["2026-09-30", 5421, "expense", null],
    ["2026-09-30", 150000, "income", null],
    ["2026-10-01", 750, "expense", null],
    ["2026-10-01", 2000, "expense", null],
    ["2026-10-02", 0, "expense", "Missing amount"],
    ["2026-10-02", 0, "expense", 'Unrecognized debit "12.3.4"'],
  ]);
});

const EURO = [
  "Datum;Omschrijving;Bedrag;Saldo",
  "15/09/2026;Bakkerij Voorbeeld;-4,50;1.234,56",
  "01/10/2026;Salaris Voorbeeld BV;2.345,67;3.580,23",
  '03/10/2026;"Huur; oktober";-950,00;2.630,23',
  "04/10/2026;Supermarkt Test;-1.002,30;1.627,93",
].join("\n");

test("European semicolon file with decimal commas and DD/MM dates", () => {
  const { rows, dateOrder } = importText(EURO);
  assert.equal(dateOrder, "DMY");
  assert.deepEqual(rows.map((row) => [row.date, row.description, row.amount_cents, row.kind]), [
    ["2026-09-15", "Bakkerij Voorbeeld", 450, "expense"],
    ["2026-10-01", "Salaris Voorbeeld BV", 234567, "income"],
    ["2026-10-03", "Huur; oktober", 95000, "expense"],
    ["2026-10-04", "Supermarkt Test", 100230, "expense"],
  ]);
});

test("BOM + CRLF file with quoted descriptions, fallbacks, truncation and row errors", () => {
  const long = "X".repeat(200);
  const text =
    "\uFEFFDate,Description,Amount\r\n" +
    '10/01/2026,"Fictional Plumbing ""Pro"", LLC",-120.00\r\n' +
    "10/02/2026,,-3.00\r\n" +
    `10/03/2026,${long},-1.00\r\n` +
    "not a date,Something,-1.00\r\n" +
    "10/04/2026,Zero row,0.00\r\n" +
    "10/05/2026,Garbage amount,abc\r\n";
  const { rows } = importText(text);
  assert.equal(rows[0].description, 'Fictional Plumbing "Pro", LLC');
  assert.equal(rows[0].amount_cents, 12000);
  assert.equal(rows[1].description, "Imported transaction");
  assert.equal(rows[2].description.length, 140);
  assert.equal(rows[3].error, 'Unrecognized date "not a date"');
  assert.equal(rows[4].error, "Zero amount");
  assert.equal(rows[5].error, 'Unrecognized amount "abc"');
  for (const row of rows.slice(3)) assert.equal(row.external_id, "");
  for (const row of rows.slice(0, 3)) assert.match(row.external_id, /^csv:[0-9a-f]{16}$/);
});

/* ---------- dedupe stability ---------- */

const DUPES = [
  "Date,Description,Amount",
  "09/10/2026,SAMPLE COFFEE BAR,-4.50",
  "09/10/2026,SAMPLE COFFEE BAR,-4.50",
  "09/10/2026,sample  coffee bar,-4.50",
  "09/10/2026,SAMPLE COFFEE BAR,-5.00",
  "09/11/2026,SAMPLE COFFEE BAR,-4.50",
].join("\n");

test("re-importing the same file yields identical keys; identical rows get distinct occurrence keys", () => {
  const first = importText(DUPES).rows.map((row) => row.external_id);
  const second = importText(DUPES).rows.map((row) => row.external_id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length, "three identical coffees produce three keys");
  assert.equal(
    first[0],
    csvFingerprint({ accountId: "acct-test", date: "2026-09-10", amountCents: 450, kind: "expense", description: "SAMPLE COFFEE BAR", occurrence: 0 }),
  );
  assert.equal(
    first[2],
    csvFingerprint({ accountId: "acct-test", date: "2026-09-10", amountCents: 450, kind: "expense", description: "sample coffee bar", occurrence: 2 }),
    "case/whitespace variants count as the same description",
  );
  const otherAccount = importText(DUPES, { accountId: "acct-other" }).rows.map((row) => row.external_id);
  assert.notDeepEqual(otherAccount, first);
  // An overlapping export (a later file that also contains the first two rows) reuses their keys.
  const overlap = ["Date,Description,Amount", "09/10/2026,SAMPLE COFFEE BAR,-4.50", "09/10/2026,SAMPLE COFFEE BAR,-4.50", "09/12/2026,NEW,-1.00"].join("\n");
  const overlapKeys = importText(overlap).rows.map((row) => row.external_id);
  assert.deepEqual(overlapKeys.slice(0, 2), first.slice(0, 2));
});

/* ---------- merchants ---------- */

test("normalizeMerchant strips bank noise for grouping", () => {
  const cases: [string, string][] = [
    ["NETFLIX.COM LOS GATOS CA", "netflix los gatos"],
    ["Netflix.com", "netflix"],
    ["SPOTIFY USA 877-778-1161", "spotify usa"],
    ["DEBIT CARD PURCHASE XXXX1234 SPOTIFY P1A2B3", "spotify"],
    ["PURCHASE AUTHORIZED ON 09/14 SAMPLE GYM CLUB NY S586257 CARD 1234", "sample gym club"],
    ["POS DEBIT SAMPLE MARKET #0042 SAMPLETOWN NJ", "sample market sampletown"],
    ["RECURRING PAYMENT AUTHORIZED ON 09/01 CLOUDSTORE*1234", "cloudstore"],
    ["SAMPLE STREAMING DES:PAYMENT ID:XXXX12 INDN:SAMPLE PERSON CO ID:999 WEB", "sample streaming payment"],
    ["ACH DEBIT SAMPLE INSURANCE CO WEB ID: 9876543", "sample insurance"],
    ["SQ *SAMPLE COFFEE ROASTERS", "sample coffee roasters"],
    ["McDonald's F1234", "mcdonalds"],
    ["2026-09-01 SAMPLE THING 09/01/2026", "sample thing"],
    ["12345", ""],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeMerchant(input), expected, input);
  assert.equal(normalizeMerchant("SAMPLE GYM 09/01"), normalizeMerchant("SAMPLE GYM 10/01"));
  assert.equal(normalizeMerchant("A B C D E F"), "a b c d");
});

/* ---------- recurring ---------- */

test("addMonthsClamped is month-end safe", () => {
  assert.equal(addMonthsClamped("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsClamped("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonthsClamped("2026-11-30", 3), "2027-02-28");
  assert.equal(addMonthsClamped("2026-12-15", 1), "2027-01-15");
  assert.equal(addMonthsClamped("2026-02-28", 1, 31), "2026-03-31");
  assert.equal(addMonthsClamped("2027-02-28", 12), "2028-02-28");
});

test("detects a monthly subscription anchored on the 31st", () => {
  const txs = series(["2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"], "NETFLIX.COM", 1549);
  const [suggestion, ...rest] = detectRecurring(txs, "2026-10-05", []);
  assert.equal(rest.length, 0);
  assert.deepEqual(suggestion, {
    key: "netflix",
    name: "Netflix",
    amount_cents: 1549,
    cycle: "monthly",
    anchor_date: "2026-09-30",
    next_date: "2026-10-31",
    occurrences: 5,
    confidence: "high",
  });
});

test("monthly 31st series clamped in February keeps the 31st for the next charge", () => {
  const txs = series(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"], "SAMPLE CLOUD STORAGE", 299);
  const [suggestion] = detectRecurring(txs, "2027-03-02", []);
  assert.equal(suggestion.cycle, "monthly");
  assert.equal(suggestion.anchor_date, "2027-02-28");
  assert.equal(suggestion.next_date, "2027-03-31");
  // A charge that genuinely bills on the 28th stays on the 28th.
  const plain = series(["2026-12-28", "2027-01-28", "2027-02-28"], "SAMPLE TWENTY EIGHTH", 500);
  assert.equal(detectRecurring(plain, "2027-03-01", [])[0].next_date, "2027-03-28");
});

test("detects weekly charges and yearly renewals", () => {
  const weekly = series(["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"], "SAMPLE YOGA STUDIO 0042", 2500);
  const yearly = series(["2024-11-02", "2025-11-01"], "SAMPLE DOMAINS RENEWAL", 1899);
  const result = detectRecurring([...weekly, ...yearly], "2026-10-01", []);
  assert.deepEqual(result.map((s) => [s.name, s.cycle, s.next_date, s.occurrences, s.confidence]), [
    ["Sample Yoga Studio", "weekly", "2026-10-06", 5, "high"],
    ["Sample Domains Renewal", "yearly", "2026-11-01", 2, "medium"],
  ]);
});

test("tolerates small price changes but rejects noisy amounts", () => {
  const spotify = series(["2026-06-12", "2026-07-12", "2026-08-12", "2026-09-12"], "SPOTIFY USA", [1199, 1199, 1199, 1299]);
  const electric = series(["2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"], "SAMPLE POWER CO", [8000, 12500, 9100, 7000]);
  const result = detectRecurring([...spotify, ...electric], "2026-10-01", []);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Spotify Usa");
  assert.equal(result[0].amount_cents, 1299, "uses the most recent amount");
  // Small-dollar items get the 200-cent floor rather than 15%.
  const small = series(["2026-07-01", "2026-08-01", "2026-09-01"], "SAMPLE APP", [300, 450, 300]);
  assert.equal(detectRecurring(small, "2026-09-15", []).length, 1);
});

test("allows one outlier gap (medium confidence) but not two", () => {
  const oneSkip = series(["2026-01-05", "2026-02-05", "2026-04-05", "2026-05-05", "2026-06-05"], "SAMPLE NEWS DIGITAL", 999);
  const [suggestion] = detectRecurring(oneSkip, "2026-06-20", []);
  assert.equal(suggestion.cycle, "monthly");
  assert.equal(suggestion.confidence, "medium");
  assert.equal(suggestion.next_date, "2026-07-05");
  const twoSkips = series(["2026-01-05", "2026-02-05", "2026-04-05", "2026-05-05", "2026-07-05"], "SAMPLE NEWS DIGITAL", 999);
  assert.deepEqual(detectRecurring(twoSkips, "2026-07-20", []), []);
});

test("requires enough occurrences, a recent charge, and a recognizable cadence", () => {
  assert.deepEqual(detectRecurring(series(["2026-08-01", "2026-09-01"], "SAMPLE TWICE", 1000), "2026-09-10", []), []);
  const stale = series(["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"], "SAMPLE STALE", 1000);
  assert.deepEqual(detectRecurring(stale, "2026-10-01", []), []);
  assert.equal(detectRecurring(stale, "2026-07-15", []).length, 1, "within 1.5 cycles");
  const irregular = series(["2026-06-01", "2026-06-20", "2026-08-10", "2026-09-01"], "SAMPLE IRREGULAR", 1000);
  assert.deepEqual(detectRecurring(irregular, "2026-09-10", []), []);
  const quarterly = series(["2026-01-15", "2026-04-15", "2026-07-15"], "SAMPLE QUARTERLY INSURANCE", 12000);
  assert.equal(detectRecurring(quarterly, "2026-08-01", [])[0].cycle, "quarterly");
});

test("skips existing subscriptions, linked transactions, income and transfers", () => {
  const dates = ["2026-06-03", "2026-07-03", "2026-08-03", "2026-09-03"];
  const txs = [
    ...series(dates, "NETFLIX.COM", 1549),
    ...series(dates, "SAMPLE MUSIC", 999),
    ...dates.map((date) => tx(date, "SAMPLE LINKED", 500, "expense", "sub-1")),
    ...dates.map((date) => tx(date, "EXAMPLE EMPLOYER PAYROLL", 285789, "income")),
    ...dates.map((date) => tx(date, "Transfer to Savings", 20000, "transfer")),
  ];
  const result = detectRecurring(txs, "2026-09-20", ["Netflix", ""]);
  assert.deepEqual(result.map((s) => s.name), ["Sample Music"]);
  assert.deepEqual(detectRecurring(txs, "2026-09-20", ["Netflix", "Sample Music Family Plan"]), []);
});

test("suggestions sort by next date then name and group across description noise", () => {
  const txs = [
    tx("2026-07-14", "PURCHASE AUTHORIZED ON 07/13 SAMPLE GYM CARD 1234", 4000),
    tx("2026-08-14", "PURCHASE AUTHORIZED ON 08/13 SAMPLE GYM CARD 1234", 4000),
    tx("2026-09-14", "PURCHASE AUTHORIZED ON 09/13 SAMPLE GYM CARD 1234", 4000),
    ...series(["2026-07-10", "2026-08-10", "2026-09-10"], "B SAMPLE", 100),
    ...series(["2026-07-10", "2026-08-10", "2026-09-10"], "A SAMPLE", 100),
  ];
  const result = detectRecurring(txs, "2026-09-20", []);
  assert.deepEqual(result.map((s) => [s.name, s.next_date]), [
    ["A Sample", "2026-10-10"],
    ["B Sample", "2026-10-10"],
    ["Sample Gym", "2026-10-14"],
  ]);
  assert.equal(result[2].occurrences, 3);
  assert.equal(result[2].confidence, "medium");
});

test("end-to-end: imported CSV rows feed recurring detection", () => {
  const csv = [
    "Date,Description,Amount",
    "07/02/2026,SAMPLE STREAM*SERVICE 0123,-9.99",
    "08/02/2026,SAMPLE STREAM*SERVICE 0456,-9.99",
    "09/02/2026,SAMPLE STREAM*SERVICE 0789,-9.99",
    "09/03/2026,ONE OFF STORE,-40.00",
  ].join("\n");
  const imported = ok(importText(csv).rows).map((row) => tx(row.date, row.description, row.amount_cents, row.kind));
  const result = detectRecurring(imported, "2026-09-10", []);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Sample Stream Service");
  assert.equal(result[0].amount_cents, 999);
  assert.equal(result[0].next_date, "2026-10-02");
});
