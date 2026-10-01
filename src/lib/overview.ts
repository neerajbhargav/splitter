import { groupDebts, netBalances, type Tx } from "./debts";
import type { Expense, Group, Member, Profile } from "./types";

export type GroupSummary = { group: Group; members: Member[]; mine: Member | undefined; myNet: number; debts: Tx[] };
export type PersonBalance = {
  key: string;
  name: string;
  color: string;
  avatar: string | null;
  currency: string;
  amount: number; // positive: they owe you. negative: you owe them.
  groups: { groupId: string; groupName: string; amount: number }[];
};
export type Totals = Record<string, { owe: number; owed: number }>;

export function avatarFor(m: Member | undefined, profiles: Profile[]): string | null {
  if (!m?.user_id) return null;
  return profiles.find((p) => p.id === m.user_id)?.avatar_url ?? null;
}

/** Balances across every group, merged per person (and per currency), like the Splitwise dashboard. */
export function summarize(
  data: { groups: Group[]; members: Member[]; expenses: Expense[]; profiles: Profile[] },
  myUserId: string,
) {
  const groups: GroupSummary[] = [];
  const people = new Map<string, PersonBalance>();
  for (const g of data.groups) {
    const members = data.members.filter((m) => m.group_id === g.id);
    const mine = members.find((m) => m.user_id === myUserId);
    const exps = data.expenses.filter((e) => e.group_id === g.id && !e.deleted_at);
    const ids = members.map((m) => m.id);
    const net = netBalances(ids, exps);
    const debts = groupDebts(ids, exps, g.simplify_debts);
    groups.push({ group: g, members, mine, myNet: mine ? net[mine.id] ?? 0 : 0, debts });
    if (!mine) continue;
    for (const t of debts) {
      let otherId: string;
      let amount: number;
      if (t.to === mine.id) {
        otherId = t.from;
        amount = t.amount;
      } else if (t.from === mine.id) {
        otherId = t.to;
        amount = -t.amount;
      } else continue;
      const other = members.find((m) => m.id === otherId);
      if (!other) continue;
      const key = `${other.user_id ?? "m:" + other.id}|${g.currency}`;
      const pb = people.get(key) ?? {
        key, name: other.display_name, color: other.color, avatar: avatarFor(other, data.profiles), currency: g.currency, amount: 0, groups: [],
      };
      pb.amount += amount;
      pb.groups.push({ groupId: g.id, groupName: g.name, amount });
      people.set(key, pb);
    }
  }
  const list = [...people.values()].filter((p) => p.amount !== 0);
  const totals: Totals = {};
  for (const p of list) {
    const t = (totals[p.currency] ??= { owe: 0, owed: 0 });
    if (p.amount > 0) t.owed += p.amount;
    else t.owe += -p.amount;
  }
  return {
    groups,
    owesYou: list.filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount),
    youOwe: list.filter((p) => p.amount < 0).sort((a, b) => a.amount - b.amount),
    totals,
  };
}
