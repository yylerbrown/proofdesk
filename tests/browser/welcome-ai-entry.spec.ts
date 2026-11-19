import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The demo welcome page's quiet line to a ticket an AI assistant worked, in a real browser. It
// only exists when the server runs as the demo, so this file starts a copy of the app with
// DEMO=on on its own port, and stops it at the end. The checks: with the line in place, all
// three roles still fit on the first screen of a laptop and a phone, and one press opens the
// recorded ticket in the team's view, whose note opens "How this was run".

const port = Number(process.env.BROWSER_TEST_PORT ?? 3999) + 5;
const baseURL = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
let databaseDir: string | undefined;

test.use({ baseURL });

test.beforeAll(async () => {
  databaseDir = mkdtempSync(path.join(tmpdir(), "support-desk-welcome-"));
  server = spawn("npx", ["tsx", "src/server/index.ts"], {
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATABASE_PATH: path.join(databaseDir, "demo.db"),
      DEMO: "on",
      DEV_SIGN_IN: "off",
      TICKET_PREFIX: "SUP",
      BETTER_AUTH_SECRET: "",
      BETTER_AUTH_URL: "",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    },
  });
  // Wait up to 30 seconds for the demo copy to answer.
  for (let tries = 0; tries < 60; tries += 1) {
    const ready = await fetch(`${baseURL}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The demo copy of the app did not start.");
});

test.afterAll(() => {
  server?.kill();
  if (databaseDir !== undefined) rmSync(databaseDir, { recursive: true, force: true });
});

const LABEL = "Or see a ticket an AI assistant worked (a recorded run)";

const screens: [number, number][] = [
  [1280, 800],
  [390, 844],
];
for (const [width, height] of screens) {
  test(`at ${width} by ${height} the line sits under the steps and all three roles still fit`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/sign-in");
    const entry = page.getByRole("button", { name: LABEL });
    await expect(entry).toBeVisible();
    const steps = await page.locator(".try-steps").boundingBox();
    const line = await entry.boundingBox();
    expect(line!.y).toBeGreaterThan(steps!.y + steps!.height - 1);
    // Small print: no taller than two lines of the steps' text.
    expect(line!.height).toBeLessThan(48);
    const rows = page.locator(".people li");
    await expect(rows).toHaveCount(3);
    const last = await rows.last().boundingBox();
    expect(last!.y + last!.height).toBeLessThanOrEqual(height);
  });
}

test("one press opens the recorded ticket as the team, and its note opens how it was run", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/sign-in");
  await page.getByRole("button", { name: LABEL }).click();
  await expect(page.locator(".site-header")).toContainText("Demo Team Member");
  const note = page.locator(".recorded-run");
  await expect(note).toBeVisible();
  await note.getByRole("link", { name: "How this was run" }).click();
  await expect(page).toHaveURL(/\/assistant-run#how-it-was-run$/);
  await expect(page.locator("details.run-details")).toHaveJSProperty("open", true);
  await expect(page.locator("#how-it-was-run")).toBeVisible();
});
