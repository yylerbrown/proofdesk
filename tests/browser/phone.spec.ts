import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// The demo on a phone, measured in a real browser: the small controls are 44-pixel tap targets,
// the header keeps one row, each ticket row stacks its title under the key and
// status, the assistant invite's links do not overlap, a select in the ticket's side panel stays inside
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

/**
 * Signs in as the demo's team member, who sees the filters, the invite and the side panel: a
 * first visit opens as the customer, and the welcome card's link switches to the team.
 */
async function signInAsTeam(page: Page) {
  await page.goto("/tickets");
  await page.getByRole("button", { name: "See the team's side" }).click();
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

  await test.step("the list's filter chips and sort links", async () => {
    await page.goto("/tickets");
    await expectTapTargets(page, 'nav[aria-label="Filter by status"] li a');
    await expectTapTargets(page, 'nav[aria-label="Filter by owner"] li a');
    await expectTapTargets(page, 'nav[aria-label="Sort by"] a');
  });

  await test.step("the person menu's button, its roles and its links", async () => {
    await expectTapTargets(page, "details.person-menu > summary");
    await page.locator("details.person-menu > summary").click();
    await expect(page.locator("details.person-menu")).toHaveAttribute("open", "");
    await expectTapTargets(page, "details.person-menu ul button");
    await expectTapTargets(page, "details.person-menu li.menu-link a");
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

  await test.step("small links among a form's controls: Cancel", async () => {
    await page.goto("/tickets/new");
    await expectTapTargets(page, ".form-actions > a");
  });
});

/** Presses Tab from the top of the page and says, for each stop, whether it is in the list's header row. */
async function tabStopsInHeaderRow(page: Page, presses: number) {
  const inHeader: boolean[] = [];
  for (let press = 0; press < presses; press += 1) {
    await page.keyboard.press("Tab");
    inHeader.push(
      await page.evaluate(() => document.activeElement?.closest("table.tickets thead") != null),
    );
  }
  return inHeader;
}

test("on a phone no keyboard stop hides in the list's undrawn header row", async ({ page }) => {
  await signInAsTeam(page);
  // At 390 wide the header row is kept for screen readers but not drawn, so nothing in it takes focus.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tickets");
  await expect(page.locator("table.tickets tbody tr").first()).toBeVisible();
  expect(await tabStopsInHeaderRow(page, 40)).not.toContain(true);
  // The column names are still there for a screen reader.
  await expect(page.locator("table.tickets thead th").first()).toHaveText("Key", {
    useInnerText: true,
  });
  // On a wide screen the drawn header row's sort links are keyboard stops as before.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tickets");
  expect(await tabStopsInHeaderRow(page, 40)).toContain(true);
});

test("on a phone the header keeps one row, with the person menu inside the screen", async ({
  page,
}) => {
  await signInAsTeam(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/tickets");
    const brand = await page.locator(".site-header a.brand").boundingBox();
    const menu = await page.locator("details.person-menu > summary").boundingBox();
    // Side by side on one row: the menu's button starts above the brand's bottom edge.
    expect(menu!.y, `at ${width}px`).toBeLessThan(brand!.y + brand!.height);
    expect(menu!.x + menu!.width, `at ${width}px`).toBeLessThanOrEqual(width);
  }
});

test("on a 390 by 664 phone the team's first ticket row is on the first screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await signInAsTeam(page);
  await page.goto("/tickets");
  const row = await page.locator("table.tickets tbody tr").first().boundingBox();
  expect(row).not.toBeNull();
  expect(row!.y + row!.height).toBeLessThanOrEqual(664);
});

test("on a phone each ticket row puts the key and status on one line over the title", async ({
  page,
}) => {
  await signInAsTeam(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/tickets");
    const rows = await page.locator("table.tickets tbody tr").evaluateAll((all) =>
      all.map((row) => {
        const [key, title, status] = [...row.querySelectorAll("td")].map((cell) =>
          cell.getBoundingClientRect(),
        );
        const box = row.getBoundingClientRect();
        return {
          sameLine: Math.abs(key!.top - status!.top) < 4,
          titleBelow: title!.top >= key!.bottom - 1,
          titleShare: title!.width / box.width,
        };
      }),
    );
    expect(rows.length, `at ${width}px`).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.sameLine, `at ${width}px`).toBe(true);
      expect(row.titleBelow, `at ${width}px`).toBe(true);
      expect(row.titleShare, `at ${width}px`).toBeGreaterThan(0.85);
    }
    // The header row is not drawn, but a screen reader still has the column names.
    await expect(page.getByRole("columnheader", { name: "Title" })).toHaveCount(1);
    const headerHeight = await page
      .locator("table.tickets thead")
      .evaluate((head) => head.getBoundingClientRect().height);
    expect(headerHeight).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("columnheader", { name: "Title" })).toBeVisible();
});

test("on a phone the admin's People link is a 44-pixel tap target", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tickets");
  await page.locator("details.person-menu > summary").click();
  await page.getByRole("button", { name: "Admin preview (read-only)" }).click();
  await page.goto("/tickets");
  await page.locator("details.person-menu > summary").click();
  await expectTapTargets(page, ".site-header .person-menu a[href='/people']");
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
    "Demo: sample data, shared with everyone who visits. It resets itself when it has been quiet for a while.",
  );
  expect(await stripLines(page)).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await stripLines(page)).toBeLessThanOrEqual(2);
});
