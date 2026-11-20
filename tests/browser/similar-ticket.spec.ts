import { expect, test, type Page } from "@playwright/test";

// The new ticket form's "Similar ticket" line, in a real browser: it appears soon after the
// person pauses, moves the Description box down by exactly its own one line, leaves focus and
// the caret in Title, adds one tab stop (its link) between Title and Description, stays one line
// tall at phone width, and never shows on load or on the edit form.

// The browser tests share one database and one filing allowance per person, so this file's
// titles are its own and it files as a person the other files rarely use.
const EARLIER = "Kettle whistles during the morning standup";
const TYPED = "Kettle whistles in standup";

async function signIn(page: Page, person: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText(person);
}

/** Files a ticket through the form and returns its key. */
async function file(page: Page, title: string): Promise<string> {
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill("It happens every morning.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);
  return new URL(page.url()).pathname.split("/").pop()!;
}

const line = (page: Page) => page.locator("#title-similar");

test.beforeEach(async ({ page }) => {
  await signIn(page, "Customer Two");
});

test("names the earlier ticket soon after the title rests, without moving focus", async ({
  page,
}) => {
  const key = await file(page, EARLIER);
  await page.goto("/tickets/new");
  const title = page.getByLabel("Title");
  const description = page.getByLabel("Description");
  const before = (await description.boundingBox())!.y;

  await title.click();
  await title.pressSequentially(TYPED);
  const typedAt = Date.now();
  await expect(line(page)).toBeVisible({ timeout: 2000 });
  // 300 ms of rest, then one local request.
  expect(Date.now() - typedAt).toBeLessThan(1500);
  await expect(line(page)).toHaveText(
    `Similar ticket: ${key} ${EARLIER} (opens in a new tab) (New)`,
  );
  const link = line(page).getByRole("link");
  await expect(link).toHaveAttribute("href", `/tickets/${key}`);
  await expect(link).toHaveAttribute("target", "_blank");

  // Focus and the caret stay where the person was typing.
  await expect(title).toBeFocused();
  expect(await title.evaluate((box: HTMLInputElement) => box.selectionStart)).toBe(TYPED.length);

  // The Description box moved down by the line's own height and no more.
  const box = (await line(page).boundingBox())!;
  const after = (await description.boundingBox())!.y;
  const lineHeight = await line(page).evaluate((element) =>
    parseFloat(getComputedStyle(element).lineHeight),
  );
  expect(box.height).toBeCloseTo(lineHeight, 0);
  expect(after - before).toBeGreaterThan(0);
  expect(after - before).toBeLessThanOrEqual(box.height + 1);

  // One tab stop between Title and Description: the link.
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(description).toBeFocused();

  // A title that no longer overlaps takes the line away.
  await title.fill("Something else entirely here");
  await expect(line(page)).toBeHidden({ timeout: 2000 });
});

test("wraps the whole title at phone width with a 120-character title, never sideways", async ({
  page,
}) => {
  const long = `Kettle whistles ${"loudly ".repeat(15)}`.slice(0, 120).trim();
  await file(page, long);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill("Kettle whistles loudly");
  await expect(line(page)).toBeVisible({ timeout: 2000 });
  const { titleCut, scrollWidth, clientWidth } = await line(page).evaluate((element) => {
    const link = element.querySelector("a")!;
    return {
      titleCut: link.scrollWidth > link.clientWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  // The words at the end tell a visitor whether it is their problem, so none is cut off.
  expect(titleCut).toBe(false);
  await expect(line(page)).toContainText(long);
  // The wrapped title never makes the page scroll sideways.
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

test("shows nothing on load, even when the form is drawn again with a matching title", async ({
  page,
}) => {
  await file(page, EARLIER);
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill(EARLIER);
  // Send it with an empty description, past the browser's own check, so the server refuses it.
  await page.getByLabel("Description").evaluate((box) => box.removeAttribute("required"));
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page.getByLabel("Title")).toHaveValue(EARLIER);
  await page.waitForTimeout(800);
  await expect(line(page)).toBeHidden();
});

test("is not on the edit form", async ({ page }) => {
  const key = await file(page, EARLIER);
  await page.goto(`/tickets/${key}/edit`);
  await page.getByLabel("Title").fill(TYPED);
  await page.waitForTimeout(800);
  await expect(page.locator("#title-similar")).toHaveCount(0);
});
