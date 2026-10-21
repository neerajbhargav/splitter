"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, LockKeyhole, Settings2 } from "lucide-react";
import { Loading } from "@/components/ui";
import { useMe } from "@/components/providers";
import { ADD_TRANSACTION_EVENT, useQuickAdd } from "@/components/Shell";
import { FinanceProvider, useFinance } from "@/components/finance/FinanceProvider";
import { SettingsModal } from "@/components/finance/SettingsModal";
import { TransactionEditor } from "@/components/finance/TransactionEditor";
import { MONEY_SECTIONS, sectionActive } from "@/components/finance/sections";
import { greeting } from "@/lib/format";

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { currency, demo, setDemo, settings } = useFinance();
  const nav = useRef<HTMLElement>(null);
  const me = useMe();
  const quickAdd = useQuickAdd();
  const [adding, setAdding] = useState(false);
  const first = (me.profile?.display_name ?? "").split(" ")[0];
  const active = (href: string) => sectionActive(path, href);

  // The app-wide "+" asks for this when you're already in your money.
  useEffect(() => {
    const open = () => setAdding(true);
    window.addEventListener(ADD_TRANSACTION_EVENT, open);
    return () => window.removeEventListener(ADD_TRANSACTION_EVENT, open);
  }, []);

  useEffect(() => {
    nav.current?.querySelector<HTMLElement>("a.on")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [path]);

  return (
    <main className="page fin-page">
      <div className="fin-head">
        <div className="min0">
          <div className="eyebrow">{greeting()}{first ? `, ${first}` : ""}</div>
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
      <nav ref={nav} className="fin-nav fin-nav-money" aria-label="Your money">
        {MONEY_SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className={active(s.href) ? "on" : ""} aria-current={active(s.href) ? "page" : undefined}>{s.label}</Link>
        ))}
      </nav>
      <div className="fin-body">{children}</div>
      <SettingsModal />
      <TransactionEditor open={adding} tx={null} defaults={{ kind: "expense" }} onClose={() => setAdding(false)}
        onSplit={(p) => { setAdding(false); quickAdd.open(null, p); }} />
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
