# Self-hosting SPLITTER

About 15 minutes of console work: a free Supabase project, two OAuth apps, and a Vercel project.

## 1. Supabase project

1. Create a free project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Open **SQL Editor > New query**, paste all of [`supabase/schema.sql`](../supabase/schema.sql), and click **Run**. It is safe to re-run.
3. Open **Project Settings > API** (or the **Connect** button) and copy the **Project URL** and the **anon / publishable key**.

## 2. Sign-in providers

In Supabase go to **Authentication > Sign In / Providers**. Both providers need this callback URL:

```
https://<your-project-ref>.supabase.co/auth/v1/callback
```

GitHub:

1. GitHub > Settings > Developer settings > [OAuth Apps](https://github.com/settings/developers) > New OAuth App.
2. Homepage URL: your Vercel URL. Authorization callback URL: the Supabase callback above.
3. Copy the Client ID, generate a Client Secret, and paste both into the GitHub provider in Supabase. Enable it.

Google:

1. [Google Cloud Console](https://console.cloud.google.com/) > APIs & Services > Google Auth Platform. Set up Branding (app name, support email) and an External audience.
2. Clients > Create client > **Web application**. Authorized redirect URI: the Supabase callback above.
3. Paste the Client ID and Secret into the Google provider in Supabase. Enable it.
4. While the app is in "Testing", add your housemates' Gmail addresses as test users, or publish the app.

Email links work out of the box. Supabase's built-in mailer is rate limited; add custom SMTP under Authentication > Emails for heavier use.

## 3. Tell Supabase where the app lives

**Authentication > URL Configuration**

- Site URL: `https://<your-app>.vercel.app`
- Redirect URLs: `https://<your-app>.vercel.app/**` and `http://localhost:3000/**`

## 4. Deploy on Vercel

1. [vercel.com/new](https://vercel.com/new) > import the repo. Framework preset: Next.js.
2. Add `NEXT_PUBLIC_SUPABASE_URL` (Project URL) and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (anon / publishable key).
3. Deploy. Every push to `main` redeploys.

If the env vars are missing, the app shows a setup screen instead of crashing.

A daily Vercel cron (`vercel.json`) calls `/api/keepalive`, one small query that keeps a free Supabase project from pausing after a quiet week.

## Local development

```bash
cp .env.example .env.local   # fill in the two values
npm ci
npm run dev                  # http://localhost:3000
```

## Upgrading an existing database

A fresh database needs only `supabase/schema.sql`. An existing one gets the migrations in `supabase/migrations/`, in name order, before the matching app version is deployed. Every migration is safe to re-run: `tests/migrations.test.ts` applies each one twice on top of the current `schema.sql`. It does not rebuild an older database, so it cannot prove an upgrade from one.

| Migration | Adds |
|---|---|
| `20261001_free_expense_tools.sql` | search, saved splits, itemization |
| `20261002_itemized_currency.sql` | foreign-currency itemized bills |
| `20261003_personal_finance.sql` | debt, budget and subscription tools |
| `20261004_finance_ledger.sql` | accounts, holdings, categories, the unified ledger and the Plaid tables; moves v1 finance data into them |
| `20261005_finance_planning.sql` | custom debt payment plans, a pay schedule, credit score history |
| `20261006_credit_score_sync.sql` | idempotent credit score sync |
| `20261021_group_fixes.sql` | split by days, owner-only group delete, first-name joining, check marks that survive edits |
| `20261021_personal_tokens.sql` | calendar and score-sync links |
| `20261023_revoke_internal_helpers.sql` | removes EXECUTE from `member_balance`, `suggest_spot` and `spot_looks_like_me`, which answered outside the group; the app keeps working |

There is no migration version table. Track what you applied yourself.

From 2026-10-02 until commit `9d1845b`, `schema.sql` alone had broken `itemized_splits` and `convert_itemized_bill` functions (the migrations were correct). A database whose last run was that `schema.sql`, not the two migrations, refuses nearly every itemized bill and every foreign-currency itemized bill. It accepts an itemized bill only when tax plus tip equals the item total or is a few cents above it. Re-running the current `schema.sql`, or the two migrations, fixes it.

No stored expense was affected, because an accepted bill got the same shares as the fixed function. The broken share was `2 × base + extra`; the fixed one is `base + floor(exact) + extra`, where `base` is a person's item total and `exact` is their part of tax plus tip. `save_expense` checks that shares add up, so it accepted a bill only when the sum of `floor(exact)` equalled the sum of `base`. That needs tax plus tip of at least the item total, which makes `floor(exact)` at least `base` for every person, so the two are equal for every person.

## Bank sync (optional, Plaid)

Bank sync needs these server-only variables. Never prefix them with `NEXT_PUBLIC_`. Leave them blank to hide bank linking.

| Variable | Value |
| --- | --- |
| `PLAID_CLIENT_ID` | Plaid client id |
| `PLAID_SECRET` | Plaid secret for the chosen environment |
| `PLAID_ENV` | `sandbox` or `production` |
| `PLAID_TOKEN_KEY` | 32 random bytes, base64. Generate with `openssl rand -base64 32` |
| `PLAID_REDIRECT_URI` | Optional, for OAuth banks. Must be https (localhost is allowed in sandbox) |

## Apple Pay Shortcut (iPhone, iOS 17 or later)

1. Shortcuts > Automation > New Automation > **Transaction**. Pick your cards, choose **Run Immediately**, then Next.
2. Add **URL Encode** with input *Merchant*, and a second **URL Encode** with input *Card*.
3. Add **URL**: `https://<your-app>/finance/activity?add=1&amount=[Amount]&merchant=[URL Encoded Text 1]&card=[URL Encoded Text 2]` (insert the variables from the Transaction trigger and the two encode steps).
4. Add **Open URLs**. Every tap now opens a prefilled entry. Nothing is saved until you press Add or split it.

The card name or its last 4 digits picks the matching account in Accounts, if you have one.
