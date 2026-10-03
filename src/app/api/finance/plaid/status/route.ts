import { NextResponse } from "next/server";
import { getPlaidConfig } from "@/lib/plaid-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lets the UI decide whether to show "Connect bank". Reveals only whether env is complete and which Plaid env.
export async function GET() {
  const config = getPlaidConfig();
  return NextResponse.json(
    { configured: Boolean(config), env: config ? config.env : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
