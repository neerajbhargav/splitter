import type { Metadata } from "next";
import { LegalPage, REPO } from "@/components/LegalPage";

export const metadata: Metadata = { title: "Privacy", description: "What SPLITTER stores, who can see it, and how to delete it." };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="November 18, 2026">
      <p>
        SPLITTER is a free, open-source app with no ads, no analytics and no tracking. Nothing you enter is sold or shared
        for marketing. The code that handles your data is public: <a href={REPO} target="_blank" rel="noreferrer">github.com/neerajbhargav/splitter</a>.
      </p>

      <h2>What is stored</h2>
      <ul>
        <li><b>Your sign-in.</b> When you sign in with Google or GitHub, SPLITTER receives your name, email address and profile picture. No password is stored.</li>
        <li><b>Guest mode.</b> Trying SPLITTER without an account makes an anonymous account tied to this browser, with only the name you type, if any. Connecting Google or GitHub later keeps the same data. A guest account that isn&apos;t opened for 30 days is deleted with everything in it; receipt photos from its groups can no longer be opened by anyone.</li>
        <li><b>Groups.</b> Group names, the names (and any email or phone) you add for the people in them, expenses, bills, comments, settle-ups and receipt photos you attach.</li>
        <li><b>Money.</b> The accounts, transactions, budgets, debts, paychecks, subscriptions and credit scores you enter or import from a CSV file.</li>
      </ul>
      <p>
        It is kept in a Postgres database and private file storage run by <a href="https://supabase.com" target="_blank" rel="noreferrer">Supabase</a> in the
        United States (us-east-1). The app is served by <a href="https://vercel.com" target="_blank" rel="noreferrer">Vercel</a>.
      </p>

      <h2>Who can see it</h2>
      <ul>
        <li>Your Money pages are yours alone. The database checks the signed-in account on every row.</li>
        <li>A group, its expenses, comments and receipt photos are visible to the people who have joined that group.</li>
        <li>Links you make for other apps (a reminder calendar, Apple Pay logging, credit score sync) are secret links. The server keeps only a hash of each one, and you can turn them off.</li>
      </ul>

      <h2>What stays on your device</h2>
      <ul>
        <li><b>Receipt reading</b> runs in your browser. The photo is not sent to an OCR service; the reading engine&apos;s files load from the jsDelivr CDN.</li>
        <li><b>Ask</b> uses your own AI key (OpenRouter, OpenAI or Anthropic). The key is kept in this browser only, and your question with a summary of your finances goes from your browser straight to that provider, under its terms. SPLITTER&apos;s server never sees the key.</li>
        <li><b>Exchange rates</b> come from the Frankfurter API (European Central Bank rates), requested by your browser.</li>
        <li>Your theme choice and a sample-data flag are kept in browser storage. The only cookies are the ones that keep you signed in.</li>
      </ul>
      <p>
        <b>Apple Pay logging</b> is off unless you set it up. Your iPhone&apos;s Shortcuts app then sends each Apple Pay purchase&apos;s amount,
        merchant and card name to your secret link, and SPLITTER saves it in Money. Apple does not share anything else with SPLITTER.
      </p>
      <p>Bank linking through Plaid is built into the code but is not turned on in this deployment.</p>

      <h2>Deleting your data</h2>
      <p>
        Account → Delete account removes your profile and everything in Money right away. Groups only you joined are deleted too.
        In a group other people have joined, your spot keeps your name so their balances still add up, and its email and phone are removed.
      </p>

      <h2>Questions</h2>
      <p>
        Open an issue at <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">github.com/neerajbhargav/splitter/issues</a>.
        If this page changes, the date above changes with it.
      </p>
    </LegalPage>
  );
}
