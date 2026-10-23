# What SPLITTER does, in detail

The app opens on your money. **Split** is one tab of it, for rent, groceries and trips you share. On desktop the sidebar lists the money sections, then **Split** with your groups under it. On phones the tab bar is Money, Activity, Add, Budget and Split, and each area has its own row of section tabs. **Add** asks whether it is your own spending or income, or a cost to split with a group.

## Shared expenses

- Sign in with Google, GitHub or an email link (Supabase Auth, OAuth with PKCE).
- Groups for a home, trip, couple or anything else, each with its own currency.
- Add people by name before they sign up. They claim their spot from the invite link, or are linked when they sign in with the email you added.
- Expenses split equally, by exact amounts, percentages or shares, with one or more payers. Every split is stored in integer cents and adds up exactly.
- Split by days lived there. Give people move-in and move-out dates in group settings, then pick **By days** and the dates a bill covers (for example a utility's service period). Each person pays for their days only; anyone without dates counts every day. This works for upcoming bills too, and a paid upcoming bill keeps its period.
- Simplify debts per group: at most people minus 1 payments, and the fewest possible when the exact search finishes in time ([measured](../eval/README.md#debt-simplification)).
- Settle up with full or partial payments and suggested amounts.
- Reminders: one tap opens your SMS or mail app with a pre-written nudge, using the phone or email you saved.
- Live sync across every device and member (Supabase Realtime), plus a refetch on reconnect and on tab focus.
- Activity feed per group and across groups. Comments, receipt photos, notes and categories on every expense.
- Recurring expenses (weekly, every 2 weeks, monthly, yearly). Due copies post when anyone opens the app.
- Delete with undo, restore from activity, and a "show deleted" filter.
- Dashboard with total balance, who owes you and whom you owe, merged per person across groups.
- Insights: spending by category, the last 6 months, paid vs share per person.
- CSV export in Splitwise's format (one column per person).
- Installable on iPhone and Android home screens (PWA manifest and icons).

## Expense tools

- Global search over every expense and payment you can read through RLS. Filter by group, category, dates or entry type. Deleted entries are excluded.
- Saved group splits: group settings save equal subsets, percentages or shares. New expenses start with that preset; old expenses never change. If a preset names inactive people, the editor falls back to an equal split with a review warning.
- Currency conversion: the editor fetches an ECB reference rate for the expense date through Frankfurter, or takes a manual rate. The original amount, the fixed rate and the rate date are kept. Weekends use the preceding published rate. Fees and spreads are not included. Balances stay in the group's currency, and a group with bills cannot relabel its base currency.
- Itemization: choose By item, enter line totals and assign people. Shared lines split equally; tax and tip follow each person's subtotal with exact, deterministic cent allocation. The server recomputes the final shares itself. Foreign-currency bills keep the original lines, tax and tip next to the converted amounts. One whole-bill conversion is spread across the lines so the converted total stays exact, and the database checks both sets of amounts.
- Receipt scanning: attach a JPG, PNG, WebP, BMP or PDF and choose Scan. English OCR runs in the browser with Tesseract.js. The engine and language files come from a CDN, but the image and its text are not sent to an OCR service. PDFs use selectable text first and fall back to OCR for image pages. At most five pages are read. HEIC can be attached, not scanned. Ambiguous dates and conflicting totals are left blank, and you review every suggestion before applying it ([measured](../eval/README.md#receipt-extraction)). Receipt files upload to private Supabase storage only when the expense is saved.

## Personal finance (private to each account)

Personal finance lives at `/finance` and never touches shared group balances.

- Overview: net worth, this month's budget pace, upcoming renewals and recent activity.
- Activity: the transaction ledger with search and filters. Import a bank CSV (columns and date order are detected, signs can be inverted) and preview every row first. Rows already imported are skipped by a stable per-row id, so re-importing a file adds nothing. Each import is a batch you can undo in one step.
- Budget: a plan per month with income, per-category limits, spending pace and progress. Categories are needs, wants or savings.
- Paycheck: a pay schedule with per-paycheck allocations.
- Accounts: checking, savings, cards, loans and investments, with holdings (symbol, shares, price) and a net worth total. Liabilities are stored as the amount owed.
- Debt payoff: avalanche, snowball or a custom order with extra monthly payments, payoff month, interest and a month-by-month schedule. Interest uses exact BigInt-cent math, and a plan stops at 600 months rather than promise a payoff it cannot reach. A card consolidation what-if compares your cards with one fixed-rate loan (APR, fee, term).
- Subscriptions: weekly to yearly items with renewal dates, a 30-day forecast and monthly and yearly equivalents. Recurring charges found in imported activity are offered as suggestions you accept or hide. Marking one canceled does not cancel it with the merchant.
- Health: six rules of thumb, each shown as pass, warn, fail or unknown.
- Credit scores: a history per bureau. Only scores from the same model family are compared.
- Ask: questions about your finances, answered by a model with your own API key (OpenRouter, OpenAI or Anthropic). The request goes from your browser straight to the provider, and the key stays in this browser.
- Reminders in your calendar: Account > Links for other apps > Reminders makes a private ICS link for Apple, Google or Outlook. It lists group bills you still owe, subscription renewals, card due days from your payoff plan and paydays, each with a 9am alert the day before.
- Credit score sync link: Account > Links for other apps > Credit score sync makes a token, so a scheduled job on your own machine can `POST /api/finance/credit-scores/sync` with `Authorization: Bearer <token>`. It can only add scores.
- Apple Pay logging: an iPhone Shortcut opens SPLITTER after every Apple Pay tap with the amount, merchant and card filled in ([setup](setup.md#apple-pay-shortcut-iphone-ios-17-or-later)).
- Bank sync through Plaid is built and optional. It is not enabled on usesplitter.vercel.app.
- Sample data: choose Explore with sample data to preview every money page. Nothing is saved in this mode, and every write is refused in the browser until you exit it.

## Privacy model

- Integer cents everywhere, in one finance currency that is locked once chosen. Group currencies are separate.
- Reads are owner-only through row level security, and the client also filters every query by `user_id` and paginates.
- Writes go only through validated RPCs. Every draft is bound to the account and currency it was opened in, and each RPC re-checks both under a per-owner lock, so a draft from before an account switch or a currency change cannot be reused.
- Plaid access tokens are sealed with AES-256-GCM on the server, bound to `user:item`, stored in a table the browser cannot read, and never sent to the browser. The browser reads only a safe connection list (institution, status, last sync).

## How the money math works

- Amounts are integer cents. Even splits give leftover cents to the first people in the list. Percentage and share splits use the largest-remainder method in exact integer math, so parts always sum to the total, and equal remainders go to the earlier person.
- Not simplified: within each expense, the people who owe pay back whoever paid, then each pair of people is netted.
- Simplified: nobody's total changes, nobody who is owed money is asked to pay, the group settles in the fewest payments the search can find, and among those the answer closest to who already owed whom wins. The search tries payment routes from people who owe to people who are owed. After 300,000 route combinations or 250 ms it falls back to biggest-debtor-pays-biggest-creditor, which settles everyone in at most n-1 payments but can use more than the fewest. [eval/README.md](../eval/README.md#debt-simplification) measures how often that happens.
- By days: shares are weighted by the days of the bill's period each person lived there (move-in and move-out dates are inclusive), with the same largest-remainder method.
- A payment is stored as an expense where the payer "paid" and the receiver "owes" the same amount, which cancels the debt.

## Rules worth knowing

- SPLITTER records who owes whom. It never moves money.
- Changing a group's currency relabels amounts; it does not convert them.
- People can be removed, or leave, only once their balance is zero.
