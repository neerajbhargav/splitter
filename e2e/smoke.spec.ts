import { expect, test, type APIRequestContext } from "@playwright/test";
import { GROUP_ID, MEMBER, STUB_URL, sessionCookie } from "./fixtures.ts";

type Write = { method: string; path: string; body: Record<string, unknown> | null };
const writes = async (request: APIRequestContext): Promise<Write[]> => (await request.get(`${STUB_URL}/__e2e/writes`)).json();

test("pages send the security headers and the image optimizer is off", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toBe("camera=(self), microphone=(), geolocation=(), payment=(), usb=()");
  expect(h["content-security-policy"]).toBe("frame-ancestors 'none'; base-uri 'self'; object-src 'none'");

  // images.unoptimized: /_next/image serves nothing, for other hosts or for this site's own files.
  for (const url of ["https://example.com/a.png", "/icon-192.png", "/icon.svg"]) {
    const img = await request.get(`/_next/image?url=${encodeURIComponent(url)}&w=64&q=75`);
    expect(img.status(), url).toBe(404);
  }
  expect((await request.get("/icon-192.png")).status()).toBe(200);
});

test.describe("signed in (stub Supabase)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ ...sessionCookie(), url: baseURL! }]);
  });

  test("simplify settles the group in one payment, and a by-days split has exact shares", async ({ page, request }) => {
    const before = (await writes(request)).length;
    await page.goto(`/groups/${GROUP_ID}`);
    await expect(page.getByRole("heading", { name: "Test House" })).toBeVisible();
    await expect(page.getByText(/spent \$150\.00/)).toBeVisible();

    await page.getByRole("tab", { name: "Balances" }).click();
    await expect(page.getByText("Simplified 3 payments down to 1.")).toBeVisible();
    const settle = page.locator(".settle-row");
    await expect(settle).toHaveCount(1);
    await expect(settle).toContainText("Cleo pays You");
    await expect(settle).toContainText("$60.00");

    await page.getByRole("button", { name: "Add expense" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Description").fill("Internet");
    await dialog.getByLabel(/^Amount/).fill("90.00");
    await dialog.getByRole("tab", { name: "By days" }).click();
    await dialog.getByLabel("Bill covers from").fill("2026-09-01");
    await dialog.getByLabel("To (last day)").fill("2026-09-30");

    // $90.00 over 30 + 30 + 10 days: Ada and Ben get 9000 * 30/70 = 3857.14 cents, Cleo 9000 * 10/70 = 1285.71.
    // Largest remainder gives the one leftover cent to Cleo (.71 beats .14): 38.57 + 38.57 + 12.86 = 90.00.
    await expect(dialog.locator(".split-row")).toHaveText([/Ada.*30 days.*\$38\.57/, /Ben.*30 days.*\$38\.57/, /Cleo.*10 days.*\$12\.86/]);
    await expect(dialog.locator(".split-total")).toContainText("30 days");

    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(dialog.getByText("E2E stub: writes are refused")).toBeVisible();

    const saves = (await writes(request)).slice(before).filter((w) => w.path === "/rest/v1/rpc/save_expense");
    expect(saves).toHaveLength(1);
    expect(saves[0].body).toMatchObject({
      p_id: null,
      p_group: GROUP_ID,
      p: {
        description: "Internet",
        amount_cents: 9000,
        split_type: "shares",
        period_start: "2026-09-01",
        period_end: "2026-09-30",
        payers: [{ member_id: MEMBER.ada, amount_cents: 9000 }],
        splits: [
          { member_id: MEMBER.ada, amount_cents: 3857, weight: 30 },
          { member_id: MEMBER.ben, amount_cents: 3857, weight: 30 },
          { member_id: MEMBER.cleo, amount_cents: 1286, weight: 10 },
        ],
      },
    });
  });

  test("sample data mode shows fictional data and refuses a write without calling the server", async ({ page, request }) => {
    // The stub's real workspace is empty, so the page starts on setup.
    await page.goto("/finance");
    await expect(page.getByText("Set up your money.")).toBeVisible();
    await page.getByRole("button", { name: "Explore with sample data first" }).click();
    await expect(page.getByRole("status").filter({ hasText: "exploring sample data" })).toBeVisible();
    await expect(page.getByText("Set up your money.")).toBeHidden();
    await expect(page.getByText("Net worth")).toBeVisible();

    const before = (await writes(request)).length;
    await page.getByRole("button", { name: "Add transaction" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Amount").fill("12.34");
    await dialog.getByLabel("Description").fill("Corner cafe");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByText("This is sample data, so nothing is saved.")).toBeVisible();
    expect(await writes(request)).toHaveLength(before);
  });
});
