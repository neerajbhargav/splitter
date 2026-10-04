"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { Eye, LockKeyhole, Settings2, Wallet } from "lucide-react";
import { Loading } from "@/components/ui";
import { FinanceProvider, useFinance } from "@/components/finance/FinanceProvider";
import { SettingsModal } from "@/components/finance/SettingsModal";

const SECTIONS = [
  { href: "/finance", label: "Overview" },
  { href: "/finance/activity", label: "Activity" },
  { href: "/finance/budget", label: "Budget" },
  { href: "/finance/paycheck", label: "Paycheck" },
  { href: "/finance/accounts", label: "Accounts" },
  { href: "/finance/debt", label: "Debt" },
  { href: "/finance/subscriptions", label: "Subscriptions" },
  { href: "/finance/health", label: "Health" },
  { href: "/finance/ask", label: "Ask" },
] as const;

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { currency, demo, setDemo, settings } = useFinance();
  const nav = useRef<HTMLElement>(null);
  const active = (href: string) => (href === "/finance" ? path === "/finance" : path.startsWith(href));

  useEffect(() => {
    nav.current?.querySelector<HTMLElement>("a.on")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [path]);

  return (
    <main className="page fin-page">
      <div className="fin-head">
        <div className="min0">
          <div className="eyebrow row-flex" style={{ gap: 6 }}><Wallet width={14} height={14} /> Personal finance</div>
          <h1 className="page-title">Your money</h1>
        </div>
        <div className="fin-head-actions">
          <span className="badge" title="Only you can see these records. They are separate from your groups."><LockKeyhole /> Private</span>
          <button type="button" className="btn btn-sm" onClick={() => settings.show()} aria-label={`Finance settings, currency ${currency}`}><Settings2 /> {currency}</button>
        </div>
      </div>
      {demo && (
        <div className="banner fin-demo" role="status">
          <Eye /> <span>You&apos;re exploring sample data. Nothing here is real and nothing you change is saved.</span>
          <button type="button" className="btn btn-sm" onClick={() => setDemo(false)}>Exit preview</button>
        </div>
      )}
      <nav ref={nav} className="fin-nav" aria-label="Finance sections">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className={active(s.href) ? "on" : ""} aria-current={active(s.href) ? "page" : undefined}>{s.label}</Link>
        ))}
      </nav>
      <div className="fin-body">{children}</div>
      <SettingsModal />
    </main>
  );
}

export default function FinanceLayout({ children }: { children: ReactNode }) {
  return (
    <FinanceProvider
      fallback={<Loading label="Loading your finances" />}
      failure={(message, retry, accountChanged) => (
        <main className="page page-narrow">
          <div className="banner neg" role="alert" style={{ marginTop: 24 }}>{message}</div>
          <button type="button" className="btn" style={{ marginTop: 12 }} onClick={retry}>{accountChanged ? "Reload" : "Try again"}</button>
        </main>
      )}
    >
      <Shell>{children}</Shell>
    </FinanceProvider>
  );
}
