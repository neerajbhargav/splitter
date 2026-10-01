# SPLITTER

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
