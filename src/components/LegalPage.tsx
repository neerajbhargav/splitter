import Link from "next/link";
import { LogoMark } from "@/components/ui";

export const REPO = "https://github.com/neerajbhargav/splitter";

/** Public, signed-out page shell for Privacy and Terms. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <main className="page page-narrow legal" style={{ paddingTop: "calc(64px + env(safe-area-inset-top))" }}>
      <Link href="/" className="brand-link"><LogoMark size={26} /><span className="wordmark">SPLIT<b>TER</b></span></Link>
      <h1 className="page-title" style={{ marginTop: 32 }}>{title}</h1>
      <p className="hint">Last updated {updated}</p>
      <div className="legal-body">{children}</div>
      <p className="hint legal-foot">
        <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link> · <a href={REPO} target="_blank" rel="noreferrer">Source on GitHub</a>
      </p>
    </main>
  );
}
