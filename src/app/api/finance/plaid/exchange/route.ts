import { type NextRequest } from "next/server";
import { institutionFromAccounts, mapAccounts, sealToken, tokenAad } from "@/lib/plaid-core";
import { HttpError, json, plaidPost, removeItemQuietly, rpc, withPlaid } from "@/lib/plaid-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { userId, currency, publicToken } -> { connectionId, institution, accounts }
// The access_token is sealed (AES-256-GCM, AAD user:item) and stored; it is never returned.
export async function POST(req: NextRequest) {
  return withPlaid(req, async (ctx) => {
    const publicToken = ctx.body.publicToken;
    if (typeof publicToken !== "string" || !/^public-[A-Za-z0-9-]{1,200}$/.test(publicToken)) {
      throw new HttpError(400, "That bank link didn't finish. Try connecting again.", "bad_request");
    }

    const ex = await plaidPost<{ access_token: string; item_id: string }>(ctx.config, "/item/public_token/exchange", {
      public_token: publicToken,
    });
    const accessToken = ex.access_token;
    const itemId = ex.item_id;

    try {
      // One /accounts/get serves both the institution name and the account rows.
      let accountsData: unknown = null;
      try {
        accountsData = await plaidPost(ctx.config, "/accounts/get", { access_token: accessToken });
      } catch {
        accountsData = null; // balances refresh again at the end of the first full sync
      }
      const inst = institutionFromAccounts(accountsData);
      let institution = inst.name;
      if (!institution && inst.id) {
        try {
          const got = await plaidPost<{ institution?: { name?: string } }>(ctx.config, "/institutions/get_by_id", {
            institution_id: inst.id,
            country_codes: ["US"],
          });
          institution = got.institution?.name?.trim().slice(0, 100) || null;
        } catch {
          institution = null;
        }
      }
      institution = institution || inst.id || "Bank";

      const sealed = await sealToken(accessToken, ctx.config.tokenKey, tokenAad(ctx.userId, itemId));
      const connectionId = await rpc<string>(ctx, "plaid_save_connection", {
        p_item_id: itemId,
        p_institution: institution,
        p_ciphertext: sealed,
      });

      const rows = mapAccounts((accountsData as { accounts?: unknown } | null)?.accounts);
      const accounts = rows.length
        ? await rpc<number>(ctx, "plaid_upsert_accounts", { p_connection: connectionId, p_accounts: rows })
        : 0;

      return json({ connectionId, institution, accounts });
    } catch (e) {
      // Saving failed: release the Item at Plaid so it isn't orphaned (and billed) with no way to reach it.
      await removeItemQuietly(ctx.config, accessToken);
      throw e;
    }
  });
}
