import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, REPO } from "@/components/LegalPage";

export const metadata: Metadata = { title: "Terms", description: "The terms for using SPLITTER." };

export default function TermsPage() {
  return (
    <LegalPage title="Terms" updated="November 18, 2026">
      <p>SPLITTER is a free, open-source personal project. By using it you agree to the following.</p>

      <h2>It is free, and provided as is</h2>
      <p>
        There is no paid plan, no ads and no warranty. The service may change, pause or end, and data could be lost, so keep your own
        copy of anything important. The source code is under the <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT license</a>,
        and you can run your own copy.
      </p>

      <h2>It is not financial advice</h2>
      <p>
        Balances, budgets, debt payoff plans and answers from Ask are arithmetic on what you enter, not advice. Check amounts before you pay
        or settle anything.
      </p>

      <h2>Use it fairly</h2>
      <p>
        Add people to a group only with their agreement, do not use it for anything unlawful, and do not try to reach other people&apos;s data
        or overload the service. Accounts that do may be removed.
      </p>

      <h2>Your data</h2>
      <p>
        What you enter stays yours. <Link href="/privacy">Privacy</Link> explains what is stored and how to delete it.
      </p>
    </LegalPage>
  );
}
