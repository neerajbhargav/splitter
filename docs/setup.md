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

Guest mode needs **Allow anonymous sign-ins** and **Allow manual linking** on (Authentication > Sign In / Providers).
4. While the app is in "Testing", add your housemates' Gmail addresses as test users, or publish the app.

Email sign-in links are hidden on the sign-in page by default. Supabase's built-in mailer only delivers to members of your Supabase team, a few an hour, so set up custom SMTP under Authentication > Emails first, then build with `NEXT_PUBLIC_EMAIL_SIGNIN=on`.

## 3. Tell Supabase where the app lives

**Authentication > URL Configuration**

- Site URL: `https://<your-app>.vercel.app`
- Redirect URLs: `https://<your-app>.vercel.app/**` and `http://localhost:3000/**`

## 4. Deploy on Vercel

1. [vercel.com/new](https://vercel.com/new) > import the repo. Framework preset: Next.js.
2. Add `NEXT_PUBLIC_SUPABASE_URL` (Project URL) and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (anon / publishable key). Set `NEXT_PUBLIC_SITE_URL` to your app's address so link previews point at your copy.
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
| `20261118_delete_account.sql` | `delete_my_account`, behind Account > Delete account |
| `20261118_guests.sql` | guest mode: profile upgrade after a guest links Google or GitHub, and a daily pg_cron job deleting guests unused for 30 days |
| `20261118_purchases.sql` | Apple Pay logging links and the `applepay` transaction source |

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

## Apple Pay logging (iPhone, iOS 17 or later)

Every Apple Pay tap is logged into Money with no confirm step. Make the link in **Account > Links for other apps > Apple Pay logging** (it carries your time zone), then:

1. Shortcuts > Automation > **+** > **Transaction**. Pick your Wallet cards, choose **Run Immediately**, then Next > Create New Shortcut.
2. Add **Get Contents of URL** and paste the link. Show More: Method **POST**, Request Body **JSON**.
3. Add three Text fields: `amount` = Shortcut Input > Amount, `merchant` = Shortcut Input > Merchant, `card` = Shortcut Input > Card or Pass.
4. Optional: add **Show Notification** with *Contents of URL* to see "Logged $4.75 at Starbucks · Coffee".

`POST /api/finance/purchases/<token>?tz=Area/City` takes JSON or a form, and answers with that one line (`&format=json` for JSON). The category is the one you last used at that merchant (a Wallet name like "Starbucks" matches its bank form "STARBUCKS STORE #1234"), else a keyword guess, else none. The card name or its last 4 digits picks the account. The same amount, merchant and card twice within two minutes is logged once, and a link can log 300 purchases a day.

To review each purchase before it saves instead, end the automation with **Open URLs** on `https://<your-app>/finance/activity?add=1&amount=[Amount]&merchant=[URL-encoded Merchant]&card=[URL-encoded Card]`.
