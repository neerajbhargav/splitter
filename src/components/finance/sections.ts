import { ArrowLeftRight, Banknote, ChartPie, CreditCard, HeartPulse, Landmark, LayoutDashboard, Repeat, Sparkles } from "lucide-react";

/** The money sections: the sidebar on desktop, the chip bar on phones. */
export const MONEY_SECTIONS = [
  { href: "/finance", label: "Overview", icon: LayoutDashboard },
  { href: "/finance/activity", label: "Activity", icon: ArrowLeftRight },
  { href: "/finance/budget", label: "Budget", icon: ChartPie },
  { href: "/finance/paycheck", label: "Paycheck", icon: Banknote },
  { href: "/finance/accounts", label: "Accounts", icon: Landmark },
  { href: "/finance/debt", label: "Debt", icon: CreditCard },
  { href: "/finance/subscriptions", label: "Subscriptions", icon: Repeat },
  { href: "/finance/health", label: "Health", icon: HeartPulse },
  { href: "/finance/ask", label: "Ask", icon: Sparkles },
] as const;

export const sectionActive = (path: string, href: string) =>
  href === "/finance" ? path === "/finance" : path === href || path.startsWith(href + "/");
