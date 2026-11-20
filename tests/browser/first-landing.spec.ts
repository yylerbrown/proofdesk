import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

// A first-time visitor to the demo, in a real browser. It only exists when the server runs as
// the demo, so this file starts a copy of the app with DEMO=on on its own port, and stops it at
// the end. The checks: with no cookies, the first screen of a laptop and a phone shows the
// header, the welcome card with its one button, and the first ticket rows, and nothing about
// keys, the source or signing in; and one press on the card's quiet link opens the recorded
// ticket in the team's view, whose note opens "How this was run".

const port = Number(process.env.BROWSER_TEST_PORT ?? 3999) + 5;
const baseURL = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
let databaseDir: string | undefined;

test.use({ baseURL });

test.beforeAll(async () => {
  databaseDir = mkdtempSync(path.join(tmpdir(), "support-desk-first-landing-"));
  server = spawn("npx", ["tsx", "src/server/index.ts"], {
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATABASE_PATH: path.join(databaseDir, "demo.db"),
      DEMO: "on",
      DEV_SIGN_IN: "off",
      SOURCE_URL: "https://code.example.com/team/desk",
      REAL_SITE_URL: "https://desk.example.com",
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

const LABEL = "See a ticket an AI assistant worked, as the team";

const screens: [number, number][] = [
  [1280, 800],
  [390, 844],
];
for (const [width, height] of screens) {
  test(`at ${width} by ${height} a first visit shows the welcome, its one button and the first tickets`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page).toHaveURL(/\/tickets$/);
    await expect(page.locator(".site-header")).toContainText("Demo Customer");
    const start = page
      .locator(".demo-welcome")
      .getByRole("button", { name: "File a sample ticket" });
    await expect(start).toBeInViewport({ ratio: 1 });
    const firstRow = page.locator("table.tickets tbody tr").first();
    await expect(firstRow).toBeInViewport({ ratio: 1 });
    // What the header and the welcome say: nothing about keys, the source or signing in.
    for (const part of [".site-header", ".demo-welcome"]) {
      const words = await page.locator(part).innerText();
      expect(words, part).not.toMatch(/\bkeys?\b|source|sign in with|GitHub|connection/i);
    }
    await expect(page.locator("details.connect")).toHaveCount(0);
    await expect(page.getByText("Source and setup")).toHaveCount(0);
  });
}

test("one press opens the recorded ticket as the team, and its note opens how it was run", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tickets");
  await page.getByRole("button", { name: LABEL }).click();
  await expect(page.locator(".site-header")).toContainText("Demo Team Member");
  const note = page.locator(".assistant-card .card-recorded");
  await expect(note).toBeVisible();
  await note.getByRole("link", { name: "How this was run" }).click();
  await expect(page).toHaveURL(/\/assistant-run#how-it-was-run$/);
  await expect(page.locator("details.run-details")).toHaveJSProperty("open", true);
  await expect(page.locator("#how-it-was-run")).toBeVisible();
});

test("Hide takes the welcome away for good, and the About link stays in the footer", async ({
  page,
}) => {
  await page.goto("/tickets");
  await page.locator(".demo-welcome").getByRole("button", { name: "Hide" }).click();
  await expect(page.locator(".demo-welcome")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".demo-welcome")).toHaveCount(0);
  await page.getByRole("link", { name: "About this demo" }).click();
  await expect(page.locator("h1")).toHaveText("About this demo");
});

test("the guided path is eight presses, from the welcome card to the customer's Yes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tickets");
  const presses = [
    "File a sample ticket",
    "File ticket",
    "Save",
    "View this ticket as a team member",
    "Take ticket and start work",
    "Mark fixed and tell the customer",
    "View this ticket as the customer who filed it",
    "Yes, it is fixed",
  ];
  for (const words of presses) {
    await page.locator("main").getByRole("button", { name: words, exact: true }).click();
    // The sample lands on the step with its three sample + buttons, the first in the box.
    if (words === "File ticket") {
      const step = page.locator("form#verify-form");
      await expect(step.locator("button.proof-add")).toHaveCount(3);
      await expect(step.locator("button.proof-add").first()).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(
        step.getByText(
          "Sample suggestions. Press one or more to add them to the box. On a real site the team's own AI assistant writes these. Edit or remove added text in the box.",
        ),
      ).toBeVisible();
    }
  }
  await expect(page.locator(".ticket-standing")).toContainText("customer confirmed");
});
