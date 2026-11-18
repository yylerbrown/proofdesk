import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// The demo on a phone, measured in a real browser: the small controls are 44-pixel tap targets,
// the assistant invite's links do not overlap, a select in the ticket's side panel stays inside
// its card, nothing scrolls sideways, and the demo strip fits its lines. The demo strip, the
// invite and the role menu only exist when the server runs as the demo, so this file starts a
// copy of the app with DEMO=on on its own port, and stops it at the end.

const port = Number(process.env.BROWSER_TEST_PORT ?? 3999) + 2;
const baseURL = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
let databaseDir: string | undefined;

test.use({ baseURL });

test.beforeAll(async () => {
  databaseDir = mkdtempSync(path.join(tmpdir(), "support-desk-phone-"));
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

/** Signs in as the demo's team member, who sees the filters, the invite and the side panel. */
async function signInAsTeam(page: Page) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Demo Team Member" }).click();
}

/** The height of every visible element the selector finds, with its words to name it. */
async function heights(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({
        words: element.textContent?.trim(),
        height: Math.round(element.getBoundingClientRect().height),
      })),
  );
}

async function expectTapTargets(page: Page, selector: string) {
  const found = await heights(page, selector);
  expect(found.length, selector).toBeGreaterThan(0);
  for (const target of found) expect(target.height, target.words).toBeGreaterThanOrEqual(44);
}

/** How many lines of text the demo strip takes. */
async function stripLines(page: Page) {
  return page.locator(".demo-strip").evaluate((strip) => {
    const words = document.createRange();
    words.selectNodeContents(strip);
    const tops = [...words.getClientRects()].map((box) => Math.round(box.top));
    return new Set(tops).size;
  });
}

async function sidewaysScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test("on a phone the small controls are 44-pixel tap targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsTeam(page);

  await test.step("the list's filter chips and Sign out", async () => {
    await page.goto("/tickets");
    await expectTapTargets(page, 'nav[aria-label="Filter by status"] li a');
    await expectTapTargets(page, 'nav[aria-label="Filter by owner"] li a');
    await expectTapTargets(page, ".site-header .sign-out button");
  });

  await test.step("the role menu's choices", async () => {
    await page.locator("details.switch-role > summary").click();
    await expect(page.locator("details.switch-role")).toHaveAttribute("open", "");
    await expectTapTargets(page, "details.switch-role ul button");
    await page.keyboard.press("Escape");
  });

  await test.step("the invite's links keep clear of each other", async () => {
    const boxes = await page.locator(".invite-actions :is(a, button)").evaluateAll((links) =>
      links.map((link) => {
        const box = link.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }),
    );
    expect(boxes.length).toBe(3);
    for (const [i, one] of boxes.entries()) {
      for (const other of boxes.slice(i + 1)) {
        const apartSideways = one.right <= other.left || other.right <= one.left;
        const apartUpDown = one.bottom <= other.top || other.bottom <= one.top;
        expect(apartSideways || apartUpDown).toBe(true);
      }
    }
  });

  await test.step("Back to all tickets and the reply's Who sees it choices", async () => {
    await page.goto("/tickets/SUP-1");
    await expectTapTargets(page, ".back a");
    await expectTapTargets(page, 'fieldset:has(input[value="note"]) label');
  });
});

test("on a phone the admin's People link is a 44-pixel tap target", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Admin preview (read-only)" }).click();
  await page.goto("/tickets");
  await expectTapTargets(page, ".site-header li.people-link a");
});

test("a select in the ticket's side panel stays inside its card", async ({ page }) => {
  await signInAsTeam(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tickets/SUP-1");
    await page.locator(".ticket-panel details.resolve > summary").click();
    const select = await page.locator('.ticket-panel select[name="reason"]').boundingBox();
    const card = await page.locator(".ticket-panel").boundingBox();
    expect(select).not.toBeNull();
    expect(card).not.toBeNull();
    expect(select!.x + select!.width, `at ${width}px`).toBeLessThanOrEqual(card!.x + card!.width);
  }
});

test("nothing scrolls sideways at 390 and 320 pixels wide", async ({ page }) => {
  await signInAsTeam(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const address of ["/tickets", "/tickets/SUP-1"]) {
      await page.goto(address);
      expect(await sidewaysScroll(page), `${address} at ${width}px`).toBe(0);
    }
  }
});

test("the demo strip says the demo resets, on one line wide and two on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/sign-in");
  await expect(page.locator(".demo-strip")).toHaveText(
    "Demo: sample data, shared with everyone who visits. It resets itself about once a day.",
  );
  expect(await stripLines(page)).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await stripLines(page)).toBeLessThanOrEqual(2);
});
