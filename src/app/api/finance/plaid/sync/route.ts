import { type NextRequest } from "next/server";
import { mapAccounts, mapSyncPage } from "@/lib/plaid-core";
import { failConnection, json, loadConnection, plaidPost, rpc, withPlaid } from "@/lib/plaid-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { userId, currency, connectionId } -> { upserted, removed, hasMore, historyPending }
// Exactly ONE /transactions/sync page per request; the client loops while hasMore.
// Errors: 409 { code: "reauth" } when the bank needs re-login (status set to 'reauth').
export async function POST(req: NextRequest) {
  return withPlaid(req, async (ctx) => {
    const conn = await loadConnection(ctx, ctx.body.connectionId);
    try {
      const data = await plaidPost<Record<string, unknown>>(ctx.config, "/transactions/sync", {
        access_token: conn.accessToken,
        ...(conn.cursor ? { cursor: conn.cursor } : {}),
        count: 250,
      });
      const page = mapSyncPage(data);

      // First page ever: make sure accounts exist so transactions attach to them.
      if (!conn.cursor) {
        const rows = mapAccounts(data.accounts);
        if (rows.length) await rpc<number>(ctx, "plaid_upsert_accounts", { p_connection: conn.connectionId, p_accounts: rows });
      }

      // Plaid can return an empty cursor while the Item's first pull hasn't started; nothing to store yet.
      if (!page.nextCursor) {
        return json({ upserted: 0, removed: 0, hasMore: false, historyPending: true });
      }

      const applied = await rpc<{ upserted: number; removed: number }>(ctx, "plaid_apply_sync", {
        p_connection: conn.connectionId,
        p_upserts: page.upserts,
        p_removed: page.removed,
        p_cursor: page.nextCursor,
      });

      // Caught up: refresh balances. Best-effort, since this page is already committed with its cursor.
      let balancesRefreshed = false;
      if (!page.hasMore) {
        try {
          const acc = await plaidPost<{ accounts?: unknown }>(ctx.config, "/accounts/get", { access_token: conn.accessToken });
          const rows = mapAccounts(acc.accounts);
          if (rows.length) await rpc<number>(ctx, "plaid_upsert_accounts", { p_connection: conn.connectionId, p_accounts: rows });
          balancesRefreshed = true;
        } catch {
          balancesRefreshed = false;
        }
      }

      return json({
        upserted: Number(applied?.upserted ?? 0),
        removed: Number(applied?.removed ?? 0),
        hasMore: page.hasMore,
        historyPending: page.updateStatus === "NOT_STARTED",
        balancesRefreshed,
      });
    } catch (e) {
      return failConnection(ctx, conn.connectionId, e);
    }
  });
}
