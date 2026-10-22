// Synthetic receipts with known ground truth for `npm run eval:receipts`.
// Nothing here is a real receipt, store, person or address: every name is built from the word lists
// below, and phone numbers use the fictional 555-01xx range. The same seed gives the same specs on
// every machine. Rendered pixels also depend on the fonts installed, so the eval records image hashes.
import { rng } from "../tests/random-ledger.ts";

export type Tier = "clean" | "mild" | "hard";
export type DateKind = "iso" | "named_mdy" | "named_dmy" | "numeric_ambiguous" | "numeric_one_reading" | "two_dates" | "none";
export type Truth = {
  merchant: string;
  /** The receipt date, or null when the receipt prints none. */
  date: string | null;
  date_kind: DateKind;
  /** "refuse" when no reader could know the date from the text: ambiguous day/month, two dates, or none. */
  date_expect: "extract" | "refuse";
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
};
/** One printed line: left text, optional right-aligned text, or a centered header line. */
export type Line = { left?: string; right?: string; center?: string };
export type Look = { font: string; size: number; ink: string; paper: string; table: string; pad: number; angle: number; blur: number; specks: number; creases: number; jpeg: number | null };
export type ReceiptSpec = { id: string; tier: Tier; lines: Line[]; truth: Truth; look: Look };

const ADJ = ["Blue", "Copper", "Golden", "Quiet", "Silver", "Little", "Maple", "Harbor", "Juniper", "Cedar", "Willow", "Amber", "Northside", "Riverbend", "Bright", "Lucky", "Green", "Twin Oaks", "Old Mill", "Red Door"];
const NOUN = ["Heron", "Kettle", "Lantern", "Fox", "Sparrow", "Anchor", "Pine", "Otter", "Thistle", "Acorn", "Comet", "Pebble", "Wren", "Birch", "Meadow"];
const KIND = ["Market", "Cafe", "Bakery", "Grocery", "Hardware", "Pharmacy", "Deli", "Books", "Kitchen", "Pantry", "Bistro", "Noodle House", "Garden Center", "Supply"];
const TAGLINE = ["Fresh Local Goods", "Since Forever", "Neighborhood Favorite", "Good Food Good Mood"];
const STREET = ["Elm", "Larch", "Quarry", "Ferry", "Orchard", "Mill", "Bayview", "Hawthorn", "Kestrel", "Linden"];
const SUFFIX = ["St", "Ave", "Rd", "Lane", "Blvd"];
const TOWN = ["Riverton", "Eastbrook", "Millbrook Falls", "Port Ellery", "Westvale", "Cedar Hollow"];
const ITEMS = ["Oat Milk", "Sourdough Loaf", "Coffee Beans", "Bananas", "Dish Soap", "Notebook", "AA Batteries", "Green Tea", "Olive Oil", "Paper Towels", "Apples", "Rice", "Pasta", "Tomatoes", "Eggs Dozen", "Yogurt", "Light Bulb", "Packing Tape", "Sparkling Water", "Cheddar", "Latte", "Croissant", "Soup of the Day", "Garden Hose", "Wood Glue"];
const BIG = ["Desk Chair", "Bookshelf", "Espresso Machine", "Area Rug", "Standing Fan"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FONTS = ["Courier New, Courier, DejaVu Sans Mono, monospace", "Menlo, DejaVu Sans Mono, monospace", "Helvetica, Arial, DejaVu Sans, sans-serif", "Georgia, DejaVu Serif, serif"];

const pad2 = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;
const money = (cents: number, comma: boolean) => {
  const s = (cents / 100).toFixed(2);
  return comma ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : s;
};
const ordinal = (d: number) => d + (d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th");

/** `n` receipt specs from `seed`. Pure: no images, no I/O. */
export function makeReceipts(seed: number, n: number): ReceiptSpec[] {
  const rand = rng(seed);
  const ri = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const weighted = <T extends string>(w: [T, number][]): T => {
    let r = rand() * w.reduce((s, [, x]) => s + x, 0);
    for (const [k, x] of w) if ((r -= x) < 0) return k;
    return w[w.length - 1][0];
  };
  const day = () => {
    // Any real calendar day from 2024-01-01 to 2026-10-21.
    const t = Date.UTC(2024, 0, 1) + ri(0, 1024) * 86_400_000;
    const d = new Date(t);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  };
  const named = (x: { y: number; m: number; d: number }, dayFirst: boolean) => {
    const mon = rand() < 0.5 ? MONTH_SHORT[x.m - 1] + (rand() < 0.2 ? "." : "") : MONTH_LONG[x.m - 1];
    if (dayFirst) return `${rand() < 0.3 ? ordinal(x.d) : x.d} ${mon}${rand() < 0.3 ? "," : ""} ${x.y}`;
    return `${mon} ${x.d}${rand() < 0.8 ? "," : ""} ${x.y}`;
  };

  const out: ReceiptSpec[] = [];
  for (let i = 0; i < n; i++) {
    const tier = weighted<Tier>([["clean", 35], ["mild", 35], ["hard", 30]]);
    // About 8% of merchants carry a digit, which the parser's header rule skips on purpose.
    let merchant = rand() < 0.08 ? `${pick(["Route", "Pier", "Station", "Dock"])} ${ri(2, 99)} ${pick(KIND)}` : `${pick(ADJ)} ${pick(NOUN)} ${pick(KIND)}`;
    if (rand() < 0.5) merchant = merchant.toUpperCase();
    const lines: Line[] = [{ center: merchant }];
    if (rand() < 0.1) lines.push({ center: pick(TAGLINE) });
    lines.push({ center: `${ri(10, 999)} ${pick(STREET)} ${pick(SUFFIX)}` }, { center: `${pick(TOWN)}` }, { center: `Tel 555-01${pad2(ri(0, 99))}` }, {});

    // Date line.
    const dateKind = weighted<DateKind>([["iso", 15], ["named_mdy", 20], ["named_dmy", 15], ["numeric_ambiguous", 20], ["numeric_one_reading", 10], ["two_dates", 10], ["none", 10]]);
    let x = day();
    let printed: string | null = null;
    let returnBy: string | null = null;
    if (dateKind === "iso") printed = iso(x.y, x.m, x.d);
    else if (dateKind === "named_mdy" || dateKind === "two_dates") printed = named(x, false);
    else if (dateKind === "named_dmy") printed = named(x, true);
    else if (dateKind === "numeric_ambiguous") {
      // Both readings are real dates and differ, so no reader can tell day from month.
      while (x.d > 12 || x.d === x.m) x = day();
      const sep = pick(["/", "-", "."]);
      const yy = rand() < 0.3 ? pad2(x.y % 100) : String(x.y);
      printed = rand() < 0.5 ? `${pad2(x.m)}${sep}${pad2(x.d)}${sep}${yy}` : `${pad2(x.d)}${sep}${pad2(x.m)}${sep}${yy}`;
    } else if (dateKind === "numeric_one_reading") {
      // Day above 12: only one reading is a real date. The parser still refuses every numeric date.
      while (x.d <= 12) x = day();
      const sep = pick(["/", "-"]);
      printed = rand() < 0.5 ? `${pad2(x.m)}${sep}${pad2(x.d)}${sep}${x.y}` : `${pad2(x.d)}${sep}${pad2(x.m)}${sep}${x.y}`;
    }
    if (dateKind === "two_dates") {
      const r = new Date(Date.UTC(x.y, x.m - 1, x.d) + 30 * 86_400_000);
      returnBy = named({ y: r.getUTCFullYear(), m: r.getUTCMonth() + 1, d: r.getUTCDate() }, false);
    }
    const time = `${pad2(ri(7, 21))}:${pad2(ri(0, 59))}`;
    if (printed) lines.push({ left: `${pick(["Date: ", "DATE ", ""])}${printed}`, right: time });
    lines.push({ left: `Reg ${ri(1, 9)}  Clerk ${ri(10, 99)}` }, {});

    // Items, then subtotal, tax, optional tip, total, tender.
    const big = rand() < 0.1;
    let subtotal = 0;
    const count = ri(2, 6);
    for (let k = 0; k < count; k++) {
      const each = big && k === 0 ? ri(20_000, 90_000) : ri(99, 2_499);
      const qty = rand() < 0.2 ? ri(2, 4) : 1;
      subtotal += each * qty;
      const name = big && k === 0 ? pick(BIG) : pick(ITEMS);
      lines.push({ left: qty > 1 ? `${name} ${qty} @ ${money(each, false)}` : name, right: money(each * qty, false) });
    }
    const rate = pick([0, 0.04, 0.0625, 0.07, 0.08, 0.08875]);
    const tax = Math.round(subtotal * rate);
    const tip = /Cafe|Bistro|Kitchen|Noodle/i.test(merchant) && rand() < 0.5 ? Math.round(subtotal * pick([0.15, 0.18, 0.2])) : 0;
    const total = subtotal + tax + tip;
    const comma = total >= 100_000 && rand() < 0.7;
    lines.push({});
    if (rand() < 0.15) lines.push({ left: "Total Items", right: String(count) });
    lines.push({ left: pick(["Subtotal", "SUBTOTAL", "Sub Total"]), right: money(subtotal, comma) });
    lines.push({ left: rate ? pick(["Tax", "Sales Tax", `Tax ${+(rate * 100).toFixed(3)}%`]) : "Tax", right: money(tax, false) });
    if (tip) lines.push({ left: "Tip", right: money(tip, false) });
    const amount = money(total, comma);
    lines.push({
      left: pick(["TOTAL", "Total", "Grand Total", "Amount Due", "Balance Due", "Total Due", "TOTAL:"]),
      right: pick([`$${amount}`, amount, `USD ${amount}`, `${amount} USD`]),
    });
    if (rand() < 0.4) {
      const cash = Math.ceil(total / 2_000) * 2_000;
      lines.push({ left: "Cash", right: money(cash, false) }, { left: "Change", right: money(cash - total, false) });
    } else lines.push({ left: `${pick(["VISA", "Mastercard", "Debit"])} ending ${ri(1000, 9999)}`, right: money(total, comma) });
    if (rand() < 0.1) lines.push({ left: "Total Savings", right: money(ri(50, 900), false) });
    lines.push({});
    if (returnBy) lines.push({ center: `Return by ${returnBy}` });
    lines.push({ center: pick(["Thank you, come again", "Thanks for visiting", "Have a nice day"]) });

    const look: Look = tier === "clean"
      ? { font: pick(FONTS), size: ri(18, 21), ink: "#111111", paper: "#ffffff", table: "#ffffff", pad: 0, angle: 0, blur: 0, specks: 0, creases: 0, jpeg: null }
      : tier === "mild"
        ? { font: pick(FONTS), size: ri(16, 19), ink: pick(["#222222", "#333333", "#444444"]), paper: pick(["#f7f4ee", "#f1efe8", "#fbfaf6"]), table: pick(["#8a8f96", "#6f6a62", "#a3a09a"]), pad: ri(24, 40), angle: (rand() * 2 - 1) * 1.5, blur: 0.4 + rand() * 0.3, specks: ri(150, 500), creases: ri(0, 1), jpeg: rand() < 0.5 ? ri(70, 90) : null }
        : { font: pick(FONTS), size: ri(14, 17), ink: pick(["#5f5f5f", "#6b6b6b", "#777777"]), paper: pick(["#dcd8ce", "#e2ddd2", "#d6d3cc"]), table: pick(["#4d4a45", "#5b6067", "#7a746b"]), pad: ri(30, 50), angle: (rand() < 0.5 ? -1 : 1) * (2.5 + rand() * 3.5), blur: 0.7 + rand() * 0.4, specks: ri(700, 1800), creases: ri(1, 3), jpeg: ri(35, 60) };
    out.push({
      id: `r${String(i).padStart(3, "0")}`,
      tier,
      lines,
      truth: { merchant, date: printed && dateKind !== "numeric_ambiguous" ? iso(x.y, x.m, x.d) : null, date_kind: dateKind, date_expect: ["numeric_ambiguous", "two_dates", "none"].includes(dateKind) ? "refuse" : "extract", subtotal_cents: subtotal, tax_cents: tax, total_cents: total },
      look,
    });
  }
  return out;
}

/** The receipt as plain text, the way perfect OCR would read it. Used to score the parser alone. */
export function receiptText(spec: ReceiptSpec): string {
  return spec.lines.map((l) => l.center ?? [l.left, l.right].filter(Boolean).join(" ")).join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** SVG for one receipt: paper on a table, rotated, with specks and creases. Deterministic per spec. */
export function receiptSvg(spec: ReceiptSpec): string {
  const { look } = spec;
  const rand = rng(Number(spec.id.slice(1)) + 7919);
  const lh = Math.round(look.size * 1.45);
  const w = Math.round(look.size * 22);
  const h = lh * (spec.lines.length + 2);
  const W = w + 2 * look.pad;
  const H = h + 2 * look.pad;
  const m = Math.round(look.size * 1.2);
  const text = spec.lines.map((l, i) => {
    const y = look.pad + lh * (i + 1.5);
    const parts: string[] = [];
    if (l.center) parts.push(`<text x="${look.pad + w / 2}" y="${y}" text-anchor="middle">${esc(l.center)}</text>`);
    if (l.left) parts.push(`<text x="${look.pad + m}" y="${y}">${esc(l.left)}</text>`);
    if (l.right) parts.push(`<text x="${look.pad + w - m}" y="${y}" text-anchor="end">${esc(l.right)}</text>`);
    return parts.join("");
  }).join("\n");
  const specks = Array.from({ length: look.specks }, () =>
    `<circle cx="${(rand() * W).toFixed(1)}" cy="${(rand() * H).toFixed(1)}" r="${(0.4 + rand() * 1.1).toFixed(2)}" fill-opacity="${(0.25 + rand() * 0.5).toFixed(2)}"/>`).join("");
  const creases = Array.from({ length: look.creases }, () => {
    const y1 = rand() * H;
    return `<line x1="0" y1="${y1.toFixed(1)}" x2="${W}" y2="${(y1 + (rand() * 2 - 1) * 40).toFixed(1)}" stroke="#9a9a9a" stroke-opacity="0.5" stroke-width="${(1 + rand() * 1.5).toFixed(1)}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${look.table}"/>
<g transform="rotate(${look.angle.toFixed(2)} ${W / 2} ${H / 2})">
<rect x="${look.pad}" y="${look.pad}" width="${w}" height="${h}" fill="${look.paper}"/>
<g font-family="${look.font}" font-size="${look.size}" fill="${look.ink}">
${text}
</g></g>
<g fill="${look.ink}">${specks}</g>${creases}
</svg>`;
}

/** Rasterize with sharp (librsvg): blur, grayscale, then PNG or a lossy JPEG. */
export async function renderReceipt(spec: ReceiptSpec): Promise<{ bytes: Buffer; ext: "png" | "jpg" }> {
  const { default: sharp } = await import("sharp");
  let img = sharp(Buffer.from(receiptSvg(spec)));
  if (spec.look.blur >= 0.3) img = img.blur(spec.look.blur);
  img = img.grayscale();
  return spec.look.jpeg
    ? { bytes: await img.jpeg({ quality: spec.look.jpeg }).toBuffer(), ext: "jpg" }
    : { bytes: await img.png({ compressionLevel: 9 }).toBuffer(), ext: "png" };
}
