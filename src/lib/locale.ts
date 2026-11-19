// The reader's locale for dates and numbers, and the currency their region uses.
// On the server and in tests there is no reader, so both stay en-US / USD and every existing
// output (calendar feeds, Apple Pay notifications, golden tests) is unchanged.

let cached: string | null = null;

/** The browser's first language ("en-GB", "de-DE", "hi-IN"), or en-US where there is no browser. */
export function appLocale(): string {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "en-US";
  if (cached) return cached;
  try {
    const wanted = navigator.languages?.[0] || navigator.language || "en-US";
    cached = Intl.NumberFormat.supportedLocalesOf([wanted]).length ? wanted : "en-US";
  } catch {
    cached = "en-US";
  }
  return cached;
}

const EURO = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];
const REGION_CURRENCY: Record<string, string> = {
  US: "USD", GB: "GBP", IN: "INR", CA: "CAD", AU: "AUD", JP: "JPY", SG: "SGD", AE: "AED", CH: "CHF", MX: "MXN", BR: "BRL",
  NZ: "NZD", HK: "HKD", CN: "CNY", KR: "KRW", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON",
  ZA: "ZAR", PH: "PHP", TH: "THB", ID: "IDR", MY: "MYR", TR: "TRY", IL: "ILS", IS: "ISK", BG: "BGN",
  ...Object.fromEntries(EURO.map((r) => [r, "EUR"])),
};

/** The currency a locale's region uses ("en-IN" → INR, "fr" → EUR via its likely region), or null when unknown. */
export function localeCurrency(locale: string): string | null {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return (region && REGION_CURRENCY[region]) || null;
  } catch {
    return null;
  }
}

// Where someone lives decides their money, not the language their phone is in: an "English (India)"
// phone in New Jersey should start in USD. So the time zone wins and the language region is the fallback.
const ZONE_CURRENCY: [RegExp, string][] = [
  [/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Indiana\/.+|Kentucky\/.+|Boise|Juneau|Adak|Nome|Sitka|Menominee|North_Dakota\/.+)$|^Pacific\/Honolulu$/, "USD"],
  [/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|Regina|St_Johns|Montreal|Moncton|Whitehorse|Yellowknife|Iqaluit)$/, "CAD"],
  [/^America\/(Mexico_City|Monterrey|Tijuana|Cancun|Merida|Chihuahua|Hermosillo|Mazatlan)$/, "MXN"],
  [/^America\/(Sao_Paulo|Fortaleza|Recife|Bahia|Manaus|Belem|Cuiaba|Campo_Grande|Porto_Velho|Boa_Vista|Rio_Branco)$/, "BRL"],
  [/^Europe\/London$/, "GBP"], [/^Europe\/Zurich$/, "CHF"], [/^Europe\/Oslo$/, "NOK"], [/^Europe\/Stockholm$/, "SEK"],
  [/^Europe\/Copenhagen$/, "DKK"], [/^Europe\/Warsaw$/, "PLN"], [/^Europe\/Prague$/, "CZK"], [/^Europe\/Budapest$/, "HUF"],
  [/^Europe\/Bucharest$/, "RON"], [/^Europe\/Sofia$/, "BGN"], [/^Europe\/Istanbul$/, "TRY"], [/^Atlantic\/Reykjavik$/, "ISK"],
  [/^Europe\/(Amsterdam|Athens|Berlin|Brussels|Dublin|Helsinki|Lisbon|Luxembourg|Madrid|Malta|Paris|Riga|Rome|Tallinn|Vienna|Vilnius|Bratislava|Ljubljana|Zagreb)$|^Asia\/Nicosia$/, "EUR"],
  [/^Asia\/(Kolkata|Calcutta)$/, "INR"], [/^Asia\/Tokyo$/, "JPY"], [/^Asia\/Singapore$/, "SGD"], [/^Asia\/Dubai$/, "AED"],
  [/^Asia\/Hong_Kong$/, "HKD"], [/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)$/, "CNY"], [/^Asia\/Seoul$/, "KRW"], [/^Asia\/Manila$/, "PHP"],
  [/^Asia\/Bangkok$/, "THB"], [/^Asia\/(Jakarta|Makassar|Jayapura|Pontianak)$/, "IDR"], [/^Asia\/(Kuala_Lumpur|Kuching)$/, "MYR"],
  [/^Asia\/(Jerusalem|Tel_Aviv)$/, "ILS"], [/^Australia\//, "AUD"], [/^Pacific\/(Auckland|Chatham)$/, "NZD"], [/^Africa\/Johannesburg$/, "ZAR"],
];

/** The currency where someone lives: from their time zone, else their language's region, else null. */
export function regionalCurrency(timeZone: string | null | undefined, locale: string): string | null {
  if (timeZone) for (const [re, cur] of ZONE_CURRENCY) if (re.test(timeZone)) return cur;
  return localeCurrency(locale);
}

/** The reader's regional currency in the browser (null on the server). */
export function deviceCurrency(): string | null {
  if (typeof window === "undefined") return null;
  let zone: string | null = null;
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* no time zone */ }
  return regionalCurrency(zone, appLocale());
}

/** A profile made in the last 10 minutes: only these get a regional default currency, never an existing account. */
export function isNewProfile(p: { created_at?: string | null } | null | undefined, now = Date.now()): boolean {
  const t = p?.created_at ? Date.parse(p.created_at) : NaN;
  return Number.isFinite(t) && now - t >= 0 && now - t < 10 * 60_000;
}
