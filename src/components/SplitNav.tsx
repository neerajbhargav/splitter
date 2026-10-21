"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Splitting with others is one tab of the app, with its own sections (like Finance used to be). */
export const SPLIT_SECTIONS = [
  { href: "/dashboard", label: "Balances" },
  { href: "/groups", label: "Groups" },
  { href: "/activity", label: "Activity" },
  { href: "/search", label: "Search" },
] as const;

export const isSplitPath = (path: string) => SPLIT_SECTIONS.some((s) => path === s.href || path.startsWith(s.href + "/"));

export function SplitNav() {
  const path = usePathname();
  return (
    <nav className="fin-nav" aria-label="Split sections">
      {SPLIT_SECTIONS.map((s) => (
        <Link key={s.href} href={s.href} className={path === s.href ? "on" : ""} aria-current={path === s.href ? "page" : undefined}>{s.label}</Link>
      ))}
    </nav>
  );
}
