// Reminder calendar (iCalendar): group bills you still owe, subscription renewals, card due days
// and paydays. Calendar apps subscribe to it and alert you the day before; nothing to install.
import { money } from "./format.ts";
import { addDays, paydaysFrom, scheduleFromSettings } from "./paycheck-planner.ts";
import { forecastSubscriptionCharges } from "./subscription-planner.ts";
import type { PayCycle, Subscription } from "./finance-types.ts";

export type CalendarFeed = {
  settings: { currency: string; pay_cycle: PayCycle | null; pay_anchor: string | null; pay_day2: number | null; paycheck_cents: number } | null;
  subscriptions: Pick<Subscription, "id" | "name" | "amount_cents" | "cycle" | "anchor_date" | "status">[];
  debt_plan: { payments: { account_id: string; monthly_cents: number | null; due_day: number | null }[] } | null;
  accounts: { id: string; name: string; balance_cents: number; minimum_cents: number | null }[];
  /** Your unpaid shares of upcoming group bills. */
  bills: { id: string; title: string; due_date: string | null; share_cents: number; currency: string; group_name: string }[];
};

type Event = { uid: string; date: string; rank: number; summary: string; description: string };

const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// RFC 5545 lines are at most 75 octets; longer ones continue on a line starting with a space.
const fold = (line: string) => line.match(/.{1,73}/gu)!.join("\r\n ");
const day = (iso: string) => iso.replace(/-/g, "");

export function buildCalendar(feed: CalendarFeed, today: string, days = 90): string {
  const end = addDays(today, days); // exclusive
  const cur = feed.settings?.currency ?? "USD";
  const inWindow = (d: string) => d >= today && d < end;
  const events: Event[] = [];

  for (const b of feed.bills) {
    if (!b.due_date || b.share_cents <= 0) continue;
    const overdue = b.due_date < today;
    const date = overdue ? today : b.due_date;
    if (!inWindow(date)) continue;
    events.push({ uid: `bill-${b.id}`, date, rank: 0, summary: `${overdue ? "Overdue: pay" : "Pay"} ${b.title}, your share ${money(b.share_cents, b.currency)}`, description: `${b.group_name}. Tick your share in SPLITTER once you've sent it.` });
  }

  for (const p of feed.debt_plan?.payments ?? []) {
    const a = feed.accounts.find((x) => x.id === p.account_id);
    if (!p.due_day || !a || a.balance_cents <= 0) continue;
    const amount = Math.max(p.monthly_cents ?? 0, a.minimum_cents ?? 0);
    for (let k = 0; k < Math.ceil(days / 28) + 1; k++) {
      const y = +today.slice(0, 4), m = +today.slice(5, 7) - 1 + k;
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const date = new Date(Date.UTC(y, m, Math.min(p.due_day, last))).toISOString().slice(0, 10);
      if (inWindow(date)) events.push({ uid: `debt-${a.id}-${date}`, date, rank: 1, summary: `${a.name} payment due${amount ? `: ${money(amount, cur)}` : ""}`, description: "From your payoff plan in SPLITTER." });
    }
  }

  for (const c of forecastSubscriptionCharges(feed.subscriptions, today, days)) {
    events.push({ uid: `sub-${c.subscription_id}-${c.date}`, date: c.date, rank: 2, summary: `${c.name} renews: ${money(c.amount_cents, cur)}`, description: "Cancel before today if you don't want it." });
  }

  const schedule = scheduleFromSettings(feed.settings);
  if (schedule) {
    for (const d of paydaysFrom(schedule, today, Math.ceil(days / 7) + 1).filter(inWindow)) {
      events.push({ uid: `pay-${d}`, date: d, rank: 3, summary: `Payday${feed.settings?.paycheck_cents ? `: ${money(feed.settings.paycheck_cents, cur)}` : ""}`, description: "Plan where it goes in SPLITTER before it lands." });
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.rank - b.rank);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SPLITTER//Reminders//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:SPLITTER bills and paydays", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}@usesplitter`, `DTSTAMP:${day(today)}T000000Z`, `DTSTART;VALUE=DATE:${day(e.date)}`,
      `DTEND;VALUE=DATE:${day(addDays(e.date, 1))}`, `SUMMARY:${esc(e.summary)}`, `DESCRIPTION:${esc(e.description)}`, "TRANSP:TRANSPARENT",
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.summary)}`, "TRIGGER:-PT15H", "END:VALARM", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
