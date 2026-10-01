import { entryNetFor, netBalances } from "./debts";
import { category } from "./categories";
import type { Expense, Group, Member } from "./types";

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const amt = (c: number) => (c / 100).toFixed(2);

/** Splitwise-style export: one column per person with their net for each line. */
export function groupCsv(group: Group, members: Member[], expenses: Expense[]): string {
  const live = expenses.filter((e) => !e.deleted_at).sort((a, b) => a.expense_date.localeCompare(b.expense_date));
  const name = (id: string) => members.find((m) => m.id === id)?.display_name ?? "Former member";
  const rows: (string | number)[][] = [["Date", "Description", "Category", "Cost", "Currency", ...members.map((m) => m.display_name)]];
  for (const e of live) {
    const desc = e.is_payment ? `${name(e.expense_payers[0]?.member_id)} paid ${name(e.expense_splits[0]?.member_id)}` : e.description;
    rows.push([e.expense_date, desc, category(e.category).label, amt(e.amount_cents), group.currency, ...members.map((m) => amt(entryNetFor(e, m.id)))]);
  }
  const net = netBalances(members.map((m) => m.id), live);
  rows.push([]);
  rows.push(["", "Total balance", "", "", group.currency, ...members.map((m) => amt(net[m.id] ?? 0))]);
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

export function download(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
