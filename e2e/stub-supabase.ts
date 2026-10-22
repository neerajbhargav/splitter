/**
 * A tiny stand-in for Supabase, for the E2E smoke tests only. It answers the auth "who am I" call,
 * serves the synthetic rows in fixtures.ts to PostgREST reads (eq. and is.null filters; order and
 * paging are ignored), and refuses every write with a 403 while recording it at /__e2e/writes.
 * Realtime is not served: the app's live-refresh socket just fails to connect.
 */
import { createServer, type ServerResponse } from "node:http";
import { ACCESS_TOKEN, STUB_PORT, TABLES, USER } from "./fixtures.ts";

type Write = { method: string; path: string; body: unknown };
const writes: Write[] = [];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "access-control-expose-headers": "content-range",
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function select(table: string, params: URLSearchParams) {
  let rows = TABLES[table] ?? [];
  for (const [col, value] of params) {
    if (value.startsWith("eq.")) rows = rows.filter((r) => String(r[col]) === value.slice(3));
    else if (value === "is.null") rows = rows.filter((r) => r[col] == null);
  }
  return rows;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS, "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "*" });
    return res.end();
  }
  if (url.pathname === "/__e2e/writes") return send(res, 200, writes);
  if (url.pathname === "/auth/v1/user" && req.method === "GET") {
    return req.headers.authorization === `Bearer ${ACCESS_TOKEN}` ? send(res, 200, USER) : send(res, 401, { message: "invalid JWT" });
  }
  if (url.pathname.startsWith("/rest/v1/") && req.method === "GET") return send(res, 200, select(url.pathname.slice("/rest/v1/".length), url.searchParams));

  // Anything else changes data (insert, update, delete, an RPC, an upload, a sign-out): record and refuse.
  let text = "";
  for await (const chunk of req) text += chunk;
  let body: unknown = text || null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON, keep the text */ }
  writes.push({ method: req.method ?? "", path: url.pathname, body });
  send(res, 403, { code: "42501", message: "E2E stub: writes are refused", details: null, hint: null });
}).listen(STUB_PORT, "127.0.0.1", () => console.log(`supabase stub on ${STUB_PORT}`));
