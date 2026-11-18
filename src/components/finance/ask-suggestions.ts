import { moneyTight } from "./kit";

/** Starter questions, on Overview's Ask bar and the Ask page. Answered from the user's own numbers. */
export function askSuggestions(currency: string): string[] {
  return [
    "Where did most of my money go this month?",
    "What can I still spend this month?",
    `When could I be debt-free if I add ${moneyTight(20_000, currency)} a month?`,
    "Is my emergency fund big enough?",
  ];
}
