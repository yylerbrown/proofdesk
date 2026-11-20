import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// The demo on a phone, measured in a real browser: the small controls are 44-pixel tap targets,
// the header keeps one row, each ticket row stacks its title under the key and
// status, the assistant invite's links do not overlap, the ticket's opened menus and forms stay
// inside its column, nothing scrolls sideways, and the demo strip fits its lines. The demo strip, the
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
 * Signs in as the demo's team member, who sees the filters, the invite and the Status menu: a
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

  await test.step("the one link under the tickets", async () => {
    await expectTapTargets(page, ".assistant-invite a");
  });

  await test.step("The way back above the title and the reply box's two tabs", async () => {
    await page.goto("/tickets/SUP-1");
    await expectTapTargets(page, ".back a");
    await expectTapTargets(page, "fieldset.kind-tabs label");
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
  // A first visit opens as the customer; the team member comes second.
  for (const who of ["customer", "team member"]) {
    if (who === "team member") await signInAsTeam(page);
    for (const width of [390, 360, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/tickets");
      const brand = await page.locator(".site-header a.brand").boundingBox();
      // The word itself, not its link: a squeezed link is narrower than the word that spills out of it.
      const word = await page.locator(".site-header a.brand strong").boundingBox();
      const newTicket = await page.locator('.site-header a[href="/tickets/new"]').boundingBox();
      const menu = await page.locator("details.person-menu > summary").boundingBox();
      const where = `as the ${who} at ${width}px`;
      // Side by side on one row: the menu's button starts above the brand's bottom edge.
      expect(menu!.y, where).toBeLessThan(brand!.y + brand!.height);
      expect(menu!.x + menu!.width, where).toBeLessThanOrEqual(width);
      // New ticket starts after the brand ends, so it never covers the word Proofdesk.
      expect(word!.x + word!.width, where).toBeLessThanOrEqual(newTicket!.x);
    }
  }
});

test("a long name is cut short, so the header keeps its height just above phone width", async ({
  page,
}) => {
  await signInAsTeam(page);
  await page.setViewportSize({ width: 640, height: 844 });
  await page.goto("/tickets");
  const nav = page.locator(".site-header nav");
  const before = (await nav.boundingBox())!.height;
  // A name as long as a real one can be, put in place of the demo's short one.
  await page
    .locator("details.person-menu > summary strong")
    .evaluate((name) => (name.textContent = "Alexandra Catherine Montgomery-Smith"));
  expect((await nav.boundingBox())!.height).toBe(before);
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
  await page.getByRole("button", { name: "Demo Admin (read-only)" }).click();
  await page.goto("/tickets");
  await page.locator("details.person-menu > summary").click();
  await expectTapTargets(page, ".site-header .person-menu a[href='/people']");
});

test("the ticket's opened menus and resolve form stay inside its column", async ({ page }) => {
  await signInAsTeam(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const address of ["/tickets/SUP-8", "/tickets/SUP-8?step=resolve"]) {
      await page.goto(address);
      await page.locator("details.owner-menu > summary").click();
      const column = (await page.locator(".ticket-page").boundingBox())!;
      const rightEdges = await page
        .locator(".ticket-page :is(button, select, input, textarea, a, summary)")
        .evaluateAll((elements) =>
          elements
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => element.getBoundingClientRect().right),
        );
      expect(rightEdges.length, address).toBeGreaterThan(0);
      for (const right of rightEdges) {
        expect(right, `${address} at ${width}px`).toBeLessThanOrEqual(column.x + column.width + 1);
      }
      expect(await sidewaysScroll(page), `${address} at ${width}px`).toBe(0);
    }
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

test("the demo strip says the demo is shared, on one line wide and on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/sign-in");
  await expect(page.locator(".demo-strip")).toHaveText(
    "Demo: sample data, shared with every visitor.",
  );
  expect(await stripLines(page)).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await stripLines(page)).toBe(1);
});

/** Where the title ends, and where the line of status and owner and the description start. */
async function ticketColumns(page: Page) {
  return page.evaluate(() => {
    const top = (selector: string) =>
      Math.round(document.querySelector(selector)!.getBoundingClientRect().top + window.scrollY);
    const title = document.querySelector("main h1")!.getBoundingClientRect();
    return {
      facts: top(".ticket-facts"),
      description: top(".ticket-description"),
      titleBottom: Math.round(title.bottom + window.scrollY),
      left: Math.round(document.querySelector(".ticket-facts")!.getBoundingClientRect().left),
      titleLeft: Math.round(title.left),
    };
  });
}

/** The filled buttons in the page's main area, by their computed fill: dark means filled. */
async function filledButtons(page: Page) {
  return page.locator("main :is(button, [role=button])").evaluateAll((buttons) =>
    buttons
      .filter((button) => button.getClientRects().length > 0)
      .filter((button) => {
        const [red, green, blue, alpha] = (
          getComputedStyle(button).backgroundColor.match(/[\d.]+/g) ?? []
        ).map(Number);
        if (alpha === 0) return false;
        return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue! < 0.3 * 255;
      })
      .map((button) => button.textContent?.trim()),
  );
}

test("status and owner sit directly under the title on every ticket, at 1280 and 390 wide", async ({
  page,
}) => {
  await signInAsTeam(page);
  // New with no owner, In Progress after the customer's No, Resolved, and the assistant's ticket.
  const keys = ["SUP-8", "SUP-7", "SUP-6", "SUP-2"];
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const key of keys) {
      await page.goto(`/tickets/${key}`);
      const columns = await ticketColumns(page);
      // Under the title, on its left edge, before the description, and on the first screen.
      expect(columns.facts, key).toBeGreaterThanOrEqual(columns.titleBottom);
      expect(columns.facts - columns.titleBottom, key).toBeLessThan(30);
      expect(columns.facts, key).toBeLessThan(columns.description);
      expect(columns.facts, key).toBeLessThan(height);
      expect(Math.abs(columns.left - columns.titleLeft), key).toBeLessThanOrEqual(1);
      await expect(page.locator(".ticket-facts .fact-label").first()).toHaveText("Status");
      // One black button at most in the main area: the next step.
      expect((await filledButtons(page)).length, key).toBeLessThanOrEqual(1);
      expect(await sidewaysScroll(page), key).toBeLessThanOrEqual(0);
    }
  }
});

test("the column is centred under the header at 1280 wide", async ({ page }) => {
  await signInAsTeam(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tickets/SUP-8");
  const column = (await page.locator(".ticket-page").boundingBox())!;
  const left = column.x;
  const right = 1280 - (column.x + column.width);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(16);
  expect(column.width).toBeLessThan(700);
});

/** Where the focused element sits on a ticket page: which part of the page holds it. */
function focusedPart(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null) return "nothing";
    if (element.closest(".back")) return "back";
    if (element.closest(".ticket-facts .status-menu")) return "status";
    if (element.closest(".ticket-facts .owner-menu")) return "owner";
    if (element.closest(".ticket-card")) return "card";
    return "other";
  });
}

test("the keyboard reaches the status and the owner before the card's step, at 1280 wide", async ({
  page,
}) => {
  await signInAsTeam(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  // In Progress after the customer's No, and New with no owner: two different steps.
  for (const key of ["SUP-7", "SUP-8"]) {
    await page.goto(`/tickets/${key}`);
    await page.locator("main .back a").focus();
    const parts: string[] = [];
    for (let presses = 0; presses < 25; presses += 1) {
      const part = await focusedPart(page);
      if (parts.at(-1) !== part) parts.push(part);
      if (part === "card") break;
      await page.keyboard.press("Tab");
    }
    // The way back, the Status menu, the Owner menu (when it has one), then the card's step.
    // Links in the description, such as its page, may come between.
    const ownerControls = await page.locator(".ticket-facts .owner-menu").count();
    const expected = ownerControls > 0 ? ["back", "status", "owner"] : ["back", "status"];
    expect(parts.filter((part) => part !== "other").slice(0, -1), key).toEqual(expected);
    expect(parts.at(-1), key).toBe("card");
    // Inside the card, the line's link to the customer's words may come first, then the step.
    const step = page.locator(".ticket-card .next-action :is(button, [role=button])");
    for (let presses = 0; presses < 2; presses += 1) {
      if (await step.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(step).toBeFocused();
  }
});

test("on a phone each row ends in one grey line with its tag and who has it", async ({ page }) => {
  await signInAsTeam(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tickets");
  const rows = await page.locator("table.tickets tbody tr").evaluateAll((all) =>
    all.map((row) => {
      const top = (element: Element | null) => element?.getBoundingClientRect().top ?? null;
      const status = row.querySelector("td.status-cell .badge")!;
      const tag = row.querySelector(".turn-tag");
      const owner = row.querySelector("td:nth-child(5)")!;
      return {
        key: row.querySelector(".ticket-key")!.textContent,
        statusLine: Math.abs(top(status)! - top(row.querySelector(".ticket-key"))!) < 6,
        ownerBelowTitle:
          top(owner)! >= row.querySelector("td.title-cell")!.getBoundingClientRect().bottom - 1,
        tagWithOwner: tag === null || Math.abs(top(tag)! - top(owner)!) < 4,
        owner: owner.textContent?.trim(),
        ownerGrey:
          getComputedStyle(owner).color !==
          getComputedStyle(row.querySelector("td.title-cell")!).color,
      };
    }),
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.statusLine, row.key!).toBe(true);
    expect(row.ownerBelowTitle, row.key!).toBe(true);
    expect(row.tagWithOwner, row.key!).toBe(true);
    expect(row.owner, row.key!).toMatch(/^(Unassigned|Demo Team Member)$/);
    expect(row.ownerGrey, row.key!).toBe(true);
  }
  // A long tag no longer wraps under the status word: it is on the owner's line.
  const review = page.locator("table.tickets tbody tr", { hasText: "Assistant asks for review" });
  await expect(review.locator("td:nth-child(5)")).toHaveText("Demo Team Member");
  expect(await sidewaysScroll(page)).toBe(0);
});

/** The width and height a press can land on, for each visible element the selector finds. */
async function pressAreas(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { words: element.textContent?.trim(), width: box.width, height: box.height };
      }),
  );
}

async function expectPressable(page: Page, selector: string) {
  const found = await pressAreas(page, selector);
  expect(found.length, selector).toBeGreaterThan(0);
  for (const area of found) {
    expect(Math.max(area.width, area.height), `${selector}: ${area.words}`).toBeGreaterThanOrEqual(
      40,
    );
  }
}

test("on a phone the small links and Add pictures are 40 pixels or more to press", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // A first visit is the customer, with the welcome card's Hide.
  await page.goto("/tickets");
  await expectPressable(page, ".demo-welcome-hide button");
  await expectPressable(page, 'nav[aria-label="Sort by"] a');
  // The whole row opens its ticket: a press on the row's key lands on the title's link.
  const row = page.locator("table.tickets tbody tr").first();
  const key = (await row.locator(".ticket-key").boundingBox())!;
  const landed = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.closest("td.title-cell a") !== null,
    [key.x + key.width / 2, key.y + key.height / 2],
  );
  expect(landed).toBe(true);
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Change beside the customer's own check, and Add pictures on the form.
  await page.goto("/tickets/SUP-5");
  await expectPressable(page, ".card-label-link");
  await expect(page.locator(".card-label-link")).toHaveCSS("padding-top", "12px");
  await page.goto("/tickets/new");
  await expectPressable(page, "label.add-pictures .add-pictures-words");
});

test("on a phone Add pictures is a small outlined button, and a chosen picture says Remove", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tickets/new");
  const words = page.locator("label.add-pictures .add-pictures-words");
  await expect(words).toHaveCSS("border-top-style", "solid");
  await expect(words).toHaveCSS("text-decoration-line", "none");
  // A one-pixel picture, chosen as a file.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page
    .getByLabel("Add pictures")
    .setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: png });
  const remove = page.getByRole("button", { name: "Remove receipt.png" });
  await expect(remove).toBeVisible();
  const drawn = await remove.evaluate((button) => getComputedStyle(button, "::before").content);
  expect(drawn).toContain("Remove");
  expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  expect(await sidewaysScroll(page)).toBe(0);
});

test("on a phone the similar ticket's title wraps in full, with its status after it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tickets/new");
  await page.getByLabel("Title").pressSequentially("Can't sign in from my phone", { delay: 10 });
  const line = page.locator("small.similar-ticket");
  await expect(line).toBeVisible();
  const link = line.locator("a");
  // Nothing of the title is cut off.
  expect(await link.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await expect(link).toContainText("SUP-3 Cannot sign in on my phone");
  await expect(line).toContainText("(In Progress)");
  expect(await sidewaysScroll(page)).toBe(0);
});

test("on a phone the header says New, so the person's name is not cut", async ({ page }) => {
  await signInAsTeam(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tickets");
  const name = page.locator("details.person-menu > summary strong");
  await expect(name).toHaveText("Demo Team Member");
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // It reads New on the screen, and its name is still New ticket.
  const newTicket = page.getByRole("button", { name: "New ticket", exact: true });
  await expect(newTicket).toBeVisible();
  expect((await newTicket.boundingBox())!.width).toBeLessThan(60);
  await page.setViewportSize({ width: 1280, height: 800 });
  expect((await newTicket.boundingBox())!.width).toBeGreaterThan(60);
});

test("on a phone History and More options each open directly under their own line", async ({
  page,
}) => {
  await signInAsTeam(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tickets/SUP-7");
  await page.locator("details.history > summary").click();
  await page.locator("details.more-options > summary").click();
  const top = (selector: string) =>
    page.locator(selector).evaluate((element) => element.getBoundingClientRect().top);
  const history = await top("details.history > summary");
  const table = await top("details.history table");
  const more = await top("details.more-options > summary");
  const list = await top("details.more-options .more-list");
  // History's own entries come right under it, then More options, then its own entries.
  expect(table).toBeGreaterThan(history);
  expect(more).toBeGreaterThan(table);
  expect(list).toBeGreaterThan(more);
  expect(list - more).toBeLessThan(80);
});

test("on a phone the customer's No opens its box in place, scrolling only to show it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The guided path, from the customer's welcome to the question "Did this fix it?".
  await page.goto("/tickets");
  await page.getByRole("button", { name: "File a sample ticket" }).click();
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/step=verify/);
  const proof = page.locator("form textarea").first();
  if ((await proof.inputValue()) === "") await proof.fill("Every row is in the file.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "View this ticket as a team member" }).click();
  await page.getByRole("button", { name: "Take ticket and start work" }).click();
  await page.getByRole("button", { name: "Mark fixed and tell the customer" }).click();
  await page.getByRole("button", { name: "View this ticket as the customer who filed it" }).click();

  const no = page.locator("details.answer-no > summary");
  const yes = page.getByRole("button", { name: "Yes, it is fixed" });
  // The No button sits low on the screen, where its box would open below the fold.
  const at = await no.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, at - 780));
  const before = await page.evaluate(() => window.scrollY);
  const yesTop = await yes.evaluate(
    (element) => element.getBoundingClientRect().top + window.scrollY,
  );
  await no.click();
  const box = page.locator("details.answer-no textarea");
  await expect(box).toBeFocused();
  const after = await page.evaluate(() => window.scrollY);
  const boxBottom = await box.evaluate((element) => element.getBoundingClientRect().bottom);
  // The box is in sight, and the page moved no further than it took to show it.
  expect(boxBottom).toBeLessThanOrEqual(844 + 1);
  expect(after - before).toBeLessThanOrEqual(Math.max(0, boxBottom + (after - before) - 844) + 2);
  // The two buttons stay where they are in the page.
  expect(
    await yes.evaluate((element) => element.getBoundingClientRect().top + window.scrollY),
  ).toBe(yesTop);
});
