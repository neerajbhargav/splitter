export type ReceiptSuggestions = {
  description?: string;
  amount_cents?: number;
  date?: string;
  warnings: string[];
};

function validDate(year: number, month: number, day: number): string | undefined {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_TOKEN = "(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";

/** Conservative, English-first extraction. No largest-amount or date-locale guessing. */
export function parseReceipt(text: string): ReceiptSuggestions {
  const warnings: string[] = [];
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const dates = new Set<string>();
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const date = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  const named = new RegExp(`\\b${MONTH_TOKEN}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})\\b`, "gi");
  for (const match of text.matchAll(named)) {
    const date = validDate(Number(match[3]), MONTHS.indexOf(match[1].toLowerCase().slice(0, 3)) + 1, Number(match[2]));
    if (date) dates.add(date);
  }
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_TOKEN}\\.?[,]?\\s+(\\d{4})\\b`, "gi");
  for (const match of text.matchAll(dayFirst)) {
    const date = validDate(Number(match[3]), MONTHS.indexOf(match[2].toLowerCase().slice(0, 3)) + 1, Number(match[1]));
    if (date) dates.add(date);
  }
  if (dates.size > 1) warnings.push("More than one date was found. Enter the receipt date yourself.");
  else if (!dates.size) warnings.push(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/.test(text)
    ? "Numeric date order is unclear. Enter the date yourself."
    : "No unambiguous receipt date found.");

  const totals = new Set<number>();
  // A final total must have a recognized label. Exclude partial totals and tender/change lines.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\b(sub\s*total|tax|tip|gratuity|change|tender(?:ed)?|cash|savings|discount|items?|quantity)\b/i.test(line)) continue;
    const label = line.match(/^(?:grand\s+total|total(?:\s+(?:due|amount|paid))?|amount\s+due|balance\s+due)\b\s*[:=]?\s*(.*)$/i);
    if (!label) continue;
    const value = label[1] || lines[i + 1] || "";
    // Require the entire suffix to be one amount, not a date, percentage or other numeric field.
    const amount = value.match(/^(?:(?:USD|EUR|GBP|INR|CAD|AUD|JPY|SGD|AED|CHF|MXN|BRL)\s*)?[$€£₹¥]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)\s*(?:USD|EUR|GBP|INR|CAD|AUD|JPY|SGD|AED|CHF|MXN|BRL)?$/i);
    if (!amount) continue;
    const cents = Math.round(Number(amount[1].replace(/,/g, "")) * 100);
    if (Number.isSafeInteger(cents) && cents > 0) totals.add(cents);
  }
  if (!totals.size) warnings.push("No clearly labeled total found. Enter the amount yourself.");
  else if (totals.size > 1) warnings.push("Different totals were found. Check the receipt and enter the correct total.");

  // Header-only heuristic, always exposed as a reviewable suggestion.
  const description = lines.slice(0, 6).find((line) =>
    /[A-Za-z]{3}/.test(line) && line.length <= 100 &&
    !/\d|@|https?:|www\.|\b(receipt|invoice|order|date|time|tel|phone|cashier|terminal|thank|welcome|customer|street|road|avenue|subtotal|total|tax|tip|change|tender)\b/i.test(line));
  if (!description) warnings.push("Merchant name not detected. Add a description yourself.");
  return {
    ...(description ? { description } : {}),
    ...(totals.size === 1 ? { amount_cents: [...totals][0] } : {}),
    ...(dates.size === 1 ? { date: [...dates][0] } : {}),
    warnings,
  };
}
