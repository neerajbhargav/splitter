// Records docs/demo.gif for the README. Skipped unless RECORD_DEMO=1, so `npm run e2e` never runs it.
//   RECORD_DEMO=1 npx playwright test e2e/demo-gif.spec.ts
// Needs Google Chrome and ffmpeg on the machine. Everything on screen is synthetic: sample-data mode
// for the money pages, and the stub's fictional "Test House" (e2e/fixtures.ts) for the group pages.
import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { GROUP_ID, sessionCookie } from "./fixtures.ts";

test.skip(!process.env.RECORD_DEMO, "records docs/demo.gif; run with RECORD_DEMO=1");
test.use({ channel: process.env.RECORD_DEMO ? "chrome" : undefined });

const size = { width: 1280, height: 800 };
const hold = (page: Page, ms: number) => page.waitForTimeout(ms);
const glide = (l: Locator) => l.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));

test("record the README demo", async ({ browser, baseURL }, info) => {
  test.setTimeout(300_000);
  const cookie = { ...sessionCookie(), url: baseURL! };

  // next dev compiles each route on its first visit. Do that off camera.
  const warm = await browser.newContext({ viewport: size });
  await warm.addCookies([cookie]);
  const w = await warm.newPage();
  for (const path of ["/finance", "/finance/budget", "/finance/debt", `/groups/${GROUP_ID}`]) {
    await w.goto(path);
    await w.waitForLoadState("networkidle");
  }
  await warm.close();

  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: info.outputPath("video"), size } });
  await ctx.addCookies([cookie]);
  const page = await ctx.newPage();
  const nav = page.getByRole("navigation", { name: "Your money" });

  await page.goto("/finance");
  await expect(page.getByText("Set up your money.")).toBeVisible();
  await hold(page, 800);
  await page.getByRole("button", { name: "Explore with sample data first" }).click();
  await expect(page.getByText("Net worth")).toBeVisible();
  await hold(page, 2500);

  for (const section of ["Budget", "Debt"]) {
    await nav.getByRole("link", { name: section }).click();
    await page.waitForURL(`**/finance/${section.toLowerCase()}`);
    await page.waitForLoadState("networkidle");
    await hold(page, 2500);
  }

  await page.getByRole("link", { name: "Test House" }).click();
  await expect(page.getByRole("heading", { name: "Test House" })).toBeVisible();
  await hold(page, 1200);
  await page.getByRole("tab", { name: "Balances" }).click();
  await expect(page.getByText("Simplified 3 payments down to 1.")).toBeVisible();
  await glide(page.getByText("Simplified 3 payments down to 1."));
  await hold(page, 2500);

  await page.getByRole("button", { name: "Add expense" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description").pressSequentially("Internet", { delay: 60 });
  await dialog.getByLabel(/^Amount/).pressSequentially("90.00", { delay: 60 });
  await dialog.getByRole("tab", { name: "By days" }).click();
  await dialog.getByLabel("Bill covers from").fill("2026-09-01");
  await dialog.getByLabel("To (last day)").fill("2026-09-30");
  await expect(dialog.locator(".split-row")).toHaveText([/\$38\.57/, /\$38\.57/, /\$12\.86/]);
  await glide(dialog.locator(".split-total"));
  await hold(page, 3500);

  const video = page.video()!;
  await ctx.close();
  const palette = "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=5";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", await video.path(), "-vf", palette, "-loop", "0", "docs/demo.gif"]);
});
