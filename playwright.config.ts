import { defineConfig, devices } from "@playwright/test";
import { STUB_URL } from "./e2e/fixtures.ts";

const PORT = 3107;

export default defineConfig({
  testDir: "e2e",
  // The stub keeps one shared write log, so tests run one at a time.
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // The first visit to a route compiles it in next dev.
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    trace: process.env.CI ? "on" : "retain-on-failure",
  },
  webServer: [
    { command: "node e2e/stub-supabase.ts", url: `${STUB_URL}/__e2e/writes`, reuseExistingServer: false },
    {
      command: `npx next dev --port ${PORT}`,
      url: `http://localhost:${PORT}/login`,
      timeout: 180_000,
      // Never reuse a server that might point at a real Supabase project.
      reuseExistingServer: false,
      env: { NEXT_PUBLIC_SUPABASE_URL: STUB_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon-key", NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
});
