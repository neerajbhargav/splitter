import { ArrowLeftRight, Banknote, ChartPie, CreditCard, HeartPulse, Landmark, LayoutDashboard, Repeat, Sparkles, type LucideIcon } from "lucide-react";

export type MoneySection = { href: string; label: string; icon: LucideIcon; title: string; blurb: string | null };

/**
 * The money sections in three groups, the way Monarch splits tracking, budgeting and planning:
 * the sidebar on desktop, the chip bar on phones, and each page's title and one-line purpose.
 */
export const MONEY_GROUPS: { label: string | null; items: MoneySection[] }[] = [
  { label: null, items: [
    { href: "/finance", label: "Overview", icon: LayoutDashboard, title: "Your money", blurb: null },
  ] },
  { label: "Track", items: [
    { href: "/finance/activity", label: "Activity", icon: ArrowLeftRight, title: "Activity", blurb: "Every transaction in one list: Apple Pay taps, bank imports and what you add." },
    { href: "/finance/accounts", label: "Accounts", icon: Landmark, title: "Accounts", blurb: "What you have and what you owe, added up into your net worth." },
  ] },
  { label: "Budget", items: [
    { href: "/finance/budget", label: "Budget", icon: ChartPie, title: "Budget", blurb: "Give every dollar of this month a job, then see how it's going." },
    { href: "/finance/paycheck", label: "Paycheck", icon: Banknote, title: "Paycheck", blurb: "Plan where each paycheck goes before it lands." },
    { href: "/finance/subscriptions", label: "Subscriptions", icon: Repeat, title: "Subscriptions", blurb: "What renews, how much, and when." },
  ] },
  { label: "Plan", items: [
    { href: "/finance/debt", label: "Debt", icon: CreditCard, title: "Debt payoff", blurb: "Your fastest way to zero, and what each plan costs in interest." },
    { href: "/finance/health", label: "Health", icon: HeartPulse, title: "Financial health", blurb: "Six checks on your month, plus your credit scores." },
    { href: "/finance/ask", label: "Ask", icon: Sparkles, title: "Ask", blurb: "Questions answered from your own numbers, with your own AI key." },
  ] },
];

export const MONEY_SECTIONS: MoneySection[] = MONEY_GROUPS.flatMap((g) => g.items);

export const sectionActive = (path: string, href: string) =>
  href === "/finance" ? path === "/finance" : path === href || path.startsWith(href + "/");

/** The section a path belongs to, and its group's label. */
export function sectionFor(path: string): { section: MoneySection; group: string | null } {
  for (const g of MONEY_GROUPS) for (const s of g.items) if (sectionActive(path, s.href)) return { section: s, group: g.label };
  return { section: MONEY_GROUPS[0].items[0], group: null };
}
