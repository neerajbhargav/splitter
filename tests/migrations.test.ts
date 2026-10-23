// Every migration must be safe to re-run: the owner pastes them by hand, with no version table.
// This applies each one twice on top of the current schema.sql (freshDb runs each migration twice).
// It does not rebuild an older database: the harness has no copy of one.
import { test } from "node:test";
import fs from "node:fs";
import { freshDb } from "./pg-harness.ts";

const migrations = fs.readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();

for (const m of migrations) test(`migration ${m} applies twice on top of schema.sql`, async () => {
  const { db } = await freshDb(m);
  await db.close();
});
