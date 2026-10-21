import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCalendar, type CalendarFeed } from "../src/lib/calendar.ts";

const feed: CalendarFeed = {
  settings: { currency: "USD", pay_cycle: "biweekly", pay_anchor: "2026-10-23", pay_day2: null, paycheck_cents: 250_000 },
  subscriptions: [
    { id: "s1", name: "Gym, Pro; plan", amount_cents: 4_999, cycle: "monthly", anchor_date: "2026-01-31", status: "active" },
    { id: "s2", name: "Old app", amount_cents: 999, cycle: "monthly", anchor_date: "2026-01-05", status: "canceled" },
  ],
  debt_plan: { payments: [{ account_id: "card", monthly_cents: 30_000, due_day: 3 }] },
  accounts: [{ id: "card", name: "Visa", balance_cents: 120_000, minimum_cents: 4_000 }],
  bills: [
    { id: "b1", title: "PSE&G unpaid balance", due_date: "2026-09-29", share_cents: 27_604, currency: "USD", group_name: "12 Example St #2" },
    { id: "b2", title: "Verizon Wi-Fi", due_date: "2026-11-06", share_cents: 1_250, currency: "USD", group_name: "12 Example St #2" },
  ],
};

test("the reminder calendar lists bills, renewals, card due days and paydays", () => {
  const ics = buildCalendar(feed, "2026-10-21", 30);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  const events = ics.split("BEGIN:VEVENT").slice(1).map((e) => ({
    date: /DTSTART;VALUE=DATE:(\d{8})/.exec(e)![1],
    summary: /SUMMARY:(.*)\r\n/.exec(e)![1],
  }));
  assert.deepEqual(events, [
    { date: "20261021", summary: "Overdue: pay PSE&G unpaid balance\\, your share $276.04" },
    { date: "20261023", summary: "Payday: $2\\,500.00" },
    { date: "20261031", summary: "Gym\\, Pro\\; plan renews: $49.99" },
    { date: "20261103", summary: "Visa payment due: $300.00" },
    { date: "20261106", summary: "Pay Verizon Wi-Fi\\, your share $12.50" },
    { date: "20261106", summary: "Payday: $2\\,500.00" },
  ], "30 days from Oct 21 ends Nov 19, so the Nov 20 payday is left for the next refresh");
  assert.match(ics, /TRIGGER:-PT15H/, "alerts at 9am the day before");
  assert.equal(new Set(ics.match(/UID:[^\r]+/g)).size, events.length, "every event has its own stable id");
});

test("a paid-off card and a blank workspace make an empty but valid calendar", () => {
  const ics = buildCalendar({ settings: null, subscriptions: [], debt_plan: null, accounts: [], bills: [] }, "2026-10-21");
  assert.doesNotMatch(ics, /BEGIN:VEVENT/);
  assert.match(ics, /X-WR-CALNAME:SPLITTER/);
});
