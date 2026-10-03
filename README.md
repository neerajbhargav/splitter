# SPLITTER

**Live:** https://usesplitter.vercel.app

Split rent, groceries and trips with the people you live and travel with. Everyone in a group sees the same numbers, live, and one tap tells you who pays whom.

## Features

- **Sign in with Google, GitHub, or an email link** (Supabase Auth, OAuth + PKCE)
- **Groups** for a home, trip, couple or anything else, each with its own currency
- **Add people by name before they sign up.** They claim their spot from the invite link, or are linked automatically when they sign in with the email you added
- **Expenses** split equally, by exact amounts, percentages or shares, with one or multiple payers. Every split is stored in integer cents and always adds up exactly
- **Simplify debts** per group: settles everyone in the fewest payments (at most people minus 1)
- **Settle up**: record full or partial payments, with suggested amounts
- **Reminders**: one tap opens your SMS or mail app with a pre-written nudge (uses the phone or email you saved)
- **Live sync** across every device and member (Supabase Realtime), plus refresh on reconnect and tab focus
- **Activity feed** per group and across all groups
- **Comments** on every expense, **receipt photos**, notes, categories
- **Recurring expenses** (weekly, every 2 weeks, monthly, yearly). Due copies post themselves when anyone opens the app
- **Delete with undo**, restore from activity, "show deleted" filter
- **Dashboard** with total balance, who owes you, and whom you owe, merged per person across groups
- **Insights**: spending by category, last 6 months, paid vs share per person
- **CSV export** in Splitwise's format (one column per person)
- Installable on iPhone and Android home screens (PWA manifest + icons), mobile-first layout

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Supabase (Postgres, Auth, Realtime, Storage) · plain CSS · deployed on Vercel.

All writes go through Postgres functions in `supabase/schema.sql` that check group membership and validate totals. Reads are protected by Row Level Security, so the browser key is safe to expose.

---

## Setup (about 15 minutes)

### 1. Supabase project

1. Create a free project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Open **SQL Editor > New query**, paste all of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. It is safe to re-run.
3. Open **Project Settings > API** (or the **Connect** button) and copy the **Project URL** and the **anon / publishable key**.

### 2. Turn on sign-in providers

In Supabase go to **Authentication > Sign In / Providers**. The callback URL both providers need is:

```
https://<your-project-ref>.supabase.co/auth/v1/callback
```

**GitHub**
1. GitHub > Settings > Developer settings > [OAuth Apps](https://github.com/settings/developers) > New OAuth App.
2. Homepage URL: your Vercel URL. Authorization callback URL: the Supabase callback above.
3. Copy the Client ID, generate a Client Secret, and paste both into the GitHub provider in Supabase. Enable it.

**Google**
1. [Google Cloud Console](https://console.cloud.google.com/) > APIs & Services > Google Auth Platform. Set up Branding (app name SPLITTER, support email) and an External audience.
2. Clients > Create client > **Web application**. Authorized redirect URI: the Supabase callback above.
3. Paste the Client ID and Secret into the Google provider in Supabase. Enable it.
4. While the app is in "Testing", add your roommates' Gmail addresses as test users, or publish the app.

**Email links** work out of the box (Supabase's built-in mailer is rate limited; add custom SMTP under Authentication > Emails for heavier use).

### 3. Tell Supabase where the app lives

**Authentication > URL Configuration**
- Site URL: `https://<your-app>.vercel.app`
- Redirect URLs: add `https://<your-app>.vercel.app/**` and `http://localhost:3000/**`

### 4. Deploy on Vercel

1. [vercel.com/new](https://vercel.com/new) > Import this GitHub repo. Framework preset: Next.js.
2. Add environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL` = Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = anon / publishable key
3. Deploy. Every push to `main` redeploys automatically.

If the env vars are missing, the app shows a setup screen instead of crashing.

### Local development

```bash
cp .env.example .env.local   # fill in the two values
npm install
npm run dev                  # http://localhost:3000
npm test                     # split + debt math tests
```

---

## How the money math works

- Amounts are integer cents. Even splits give leftover cents to the first people in the list; percentage and share splits use the largest-remainder method, so parts always sum to the total.
- **Not simplified:** within each expense, the people who owe pay back whoever paid, then each pair of people is netted.
- **Simplified:** only each person's overall balance matters. Exact matches are paired first, then the biggest debtor pays the biggest creditor until everyone is at zero. Totals never change, only the routing.
- A payment is stored as an expense where the payer "paid" and the receiver "owes" the same amount, which cancels the debt.

## Project layout

```
supabase/schema.sql        tables, RLS policies, RPC functions, realtime, storage
src/proxy.ts               session refresh + route protection (Next 16 "proxy", formerly middleware)
src/lib/split.ts           money parsing and split math
src/lib/debts.ts           balances, pairwise debts, simplify
src/lib/data.ts            Supabase queries, RPC wrappers, live-refresh hook
src/components/            shell, expense editor, settle up, expense detail, activity
src/app/(app)/             dashboard, groups, group detail + settings, activity, account
src/app/join/[code]        invite links
tests/                     node:test suite for the math
```

## Notes

- SPLITTER records who owes whom. It never moves money.
- Changing a group's currency relabels amounts; it does not convert them.
- People can only be removed, or leave, once their balance is zero.

## Free expense tools

- **Global search:** Search opens every expense/payment you can access through RLS. Filter by group, category, dates or entry type. Deleted entries are excluded.
- **Saved group splits:** Group settings saves equal subsets, percentages or shares. New expenses start with that preset; old expenses never change. If a preset references inactive people, the editor falls back to equal splitting with a review warning.
- **Currency conversion:** The expense editor can fetch an ECB reference rate for the expense date through Frankfurter, or accept a manual rate for unsupported currencies/exact bank charges. Apply explicitly. The original amount, fixed rate and rate date are retained. Weekends use the preceding published rate. Fees/spreads are not included. Balances and splits remain in the group's currency; a group with bills cannot relabel its base currency.
- **Itemization:** Choose By item. Enter line totals in the group currency and assign people. Shared lines split equally; tax/tip are proportional to each person's subtotal with exact, deterministic cent allocation. The server independently recomputes the final shares. Foreign-currency bills retain the original lines, tax and tip alongside the converted group-currency amounts. One whole-bill conversion is allocated across components to preserve the exact converted total; the database checks both source and converted line amounts.
- **Receipt scanning:** Attach a JPG, PNG, WebP, BMP or PDF and choose Scan. English OCR runs locally using Tesseract.js; engine/language files download from CDN, but the image/text are not sent to an external OCR service. Review/edit suggestions before applying. PDFs use local selectable-text extraction first, with local OCR fallback for image pages. At most five pages are read; longer PDFs warn and leave the final total blank. Encrypted PDFs require an unlocked copy. HEIC can be attached, not scanned. Ambiguous dates and conflicting totals are left blank. Receipt files are uploaded to private Supabase storage only when the expense is saved.

For existing deployments, apply `supabase/migrations/20261001_free_expense_tools.sql` then `supabase/migrations/20261002_itemized_currency.sql` before deploying this version. Fresh deployments can use the complete idempotent schema. `npm test` includes isolated PostgreSQL/WASM permission and calculation regressions using synthetic data, not production records.

## Personal finance (private)

SPLITTER Finance v2 lives at `/finance` and absorbed the standalone Folio app. It is private to each account and independent of shared group balances.

- **Overview:** net worth, this month's budget pace, upcoming renewals and recent activity.
- **Activity:** the full transaction ledger with search and filters. Import a bank CSV (columns and date order are detected, signs can be inverted), preview every row, then import. Rows already imported are skipped by a stable per-row id, so re-importing the same file adds nothing. Each import is a batch that can be undone in one step.
- **Budget:** a plan per month with income and per-category limits, spending pace, and category progress. Categories are needs, wants or savings.
- **Accounts:** checking, savings, cards, loans and investments, with holdings (symbol, shares, price) and a net worth total. Liabilities are stored as the amount owed.
- **Debt payoff:** avalanche or snowball with extra monthly payments, payoff month, interest and a month-by-month schedule. Interest uses exact BigInt-cent arithmetic and the plan stops at 600 months rather than promising a payoff it cannot reach.
- **Subscriptions:** weekly, monthly, quarterly and yearly items with renewal dates, a 30-day forecast and monthly/yearly equivalents. Recurring charges are detected from imported activity and offered as suggestions you accept or hide. Marking one canceled does not cancel the merchant.
- **Health:** Folio's six rules, each shown as pass, warn, fail or unknown.
- **Ask:** questions about your finances answered by an AI model with your own API key. The request goes from your browser straight to the provider, and the key stays on your device.
- **Settings:** profile (income, currency), categories (rename, archive, delete with reassignment) and the sample-data toggle.

**Sample data:** choose Explore with sample data to preview every page. Nothing is saved in this mode and every write is refused until you exit it.

**Privacy model**

- Integer cents everywhere, in one finance currency that is locked once chosen. Group currencies are unaffected.
- Reads are owner-only through row level security, and the client also filters every query by `user_id` and paginates.
- Writes go only through validated RPCs. Every draft is bound to the account and currency it was opened in, and each RPC re-checks both under a per-owner lock. Switching accounts or changing currency elsewhere cannot reuse an old draft.
- Bank sync (Plaid) is optional. Access tokens are encrypted with AES-GCM on the server, stored in a table the browser cannot read, and never sent to the browser. The browser reads only a safe connection list (institution, status, last sync).

**Setup**

For an existing database, apply `supabase/migrations/20261004_finance_ledger.sql` after `20261003_personal_finance.sql`. It adds accounts, holdings, categories, a unified ledger and the Plaid tables, and moves existing v1 debts, budget transactions and subscription data into them. Fresh deployments can run `supabase/schema.sql`, which already includes it.

Bank sync needs these server-only variables (never prefix them with `NEXT_PUBLIC_`). Leave them blank to hide bank linking.

| Variable | Value |
| --- | --- |
| `PLAID_CLIENT_ID` | Plaid client id |
| `PLAID_SECRET` | Plaid secret for the chosen environment |
| `PLAID_ENV` | `sandbox` or `production` |
| `PLAID_TOKEN_KEY` | 32 random bytes, base64. Generate with `openssl rand -base64 32` |
| `PLAID_REDIRECT_URI` | Optional, for OAuth banks. Must be https (localhost is allowed in sandbox) |
