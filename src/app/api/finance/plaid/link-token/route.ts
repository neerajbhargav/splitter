import { type NextRequest } from "next/server";
import { PlaidApiError, json, loadConnection, plaidPost, withPlaid } from "@/lib/plaid-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { userId, currency, connectionId? } -> { linkToken, expiration, mode: "create" | "update" }
// With connectionId: Link update mode for an Item that needs re-login (token decrypted server-side only).
export async function POST(req: NextRequest) {
  return withPlaid(req, async (ctx) => {
    const base: Record<string, unknown> = {
      client_name: "SPLITTER",
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: ctx.userId },
    };
    if (ctx.config.redirectUri) base.redirect_uri = ctx.config.redirectUri;

    if (ctx.body.connectionId !== undefined && ctx.body.connectionId !== null) {
      const conn = await loadConnection(ctx, ctx.body.connectionId);
      const data = await plaidPost<{ link_token: string; expiration: string }>(ctx.config, "/link/token/create", {
        ...base,
        access_token: conn.accessToken,
      });
      return json({ linkToken: data.link_token, expiration: data.expiration, mode: "update" });
    }

    const create = {
      ...base,
      products: ["transactions"],
      transactions: { days_requested: 180 },
    };
    let data: { link_token: string; expiration: string };
    try {
      data = await plaidPost(ctx.config, "/link/token/create", {
        ...create,
        optional_products: ["investments", "liabilities"],
      });
    } catch (e) {
      // Optional products not enabled for this Plaid client: retry with transactions only.
      if (!(e instanceof PlaidApiError) || e.info.retry || e.info.reauth) throw e;
      data = await plaidPost(ctx.config, "/link/token/create", create);
    }
    return json({ linkToken: data.link_token, expiration: data.expiration, mode: "create" });
  });
}
