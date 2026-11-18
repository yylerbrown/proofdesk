import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The demo's "Switch role" menu in the header, at phone width. It only exists when the server
// runs as the demo, so this file starts a second copy of the app with DEMO=on on the next port,
// and stops it at the end. The checks: the button stays inside its row of the header, the list is
// as wide as the button, a click outside the open menu reaches what it was aimed at, and Escape
// closes the menu with focus back on its button.

const port = Number(process.env.BROWSER_TEST_PORT ?? 3999) + 1;
const baseURL = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
let databaseDir: string | undefined;

test.use({ baseURL, viewport: { width: 390, height: 844 } });

test.beforeAll(async () => {
  databaseDir = mkdtempSync(path.join(tmpdir(), "support-desk-demo-"));
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

test("Switch role fits its row at phone width and lets clicks outside it through", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Demo Team Member" }).click();
  await page.goto("/tickets");

  const menu = page.locator("details.switch-role");
  const summary = menu.locator("summary");

  await test.step("the button lies inside its row of the header", async () => {
    const row = await page.locator(".site-header ul.account").boundingBox();
    const button = await summary.boundingBox();
    expect(row).not.toBeNull();
    expect(button).not.toBeNull();
    expect(button!.y).toBeGreaterThanOrEqual(row!.y);
    expect(button!.y + button!.height).toBeLessThanOrEqual(row!.y + row!.height);
  });

  await test.step("the list is as wide as its button", async () => {
    await summary.click();
    await expect(menu).toHaveAttribute("open", "");
    const list = await menu.locator("summary + ul").boundingBox();
    const button = await summary.boundingBox();
    expect(Math.round(list!.width)).toBe(Math.round(button!.width));
  });

  await test.step("a click outside the open menu reaches its target", async () => {
    await page.getByRole("link", { name: "Resolved" }).first().click({ timeout: 5_000 });
    await expect(page).toHaveURL(/status=resolved/);
    await expect(menu).not.toHaveAttribute("open");
  });

  await test.step("Escape closes it and puts focus back on its button", async () => {
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await expect(menu).not.toHaveAttribute("open");
    await expect(summary).toBeFocused();
  });
});
