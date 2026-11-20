import { expect, test, type Page } from "@playwright/test";

// On the ticket page, opening and closing the Status menu, the Owner menu, History and More
// options moves nothing above them, and does not move their own lines. Status and Owner open as a
// small list floating under their button, so the description under them stays put too. History
// and More options show their content under their row, and neither line slides when the other is
// pressed, so a second press always lands on the line it was aimed at.

/** Files a ticket as a customer, then takes it as a team member, with one reply on it. */
async function ticketInProgress(page: Page): Promise<string> {
  await page.goto("/sign-in");
  // Customer Two files it, so the other journeys keep Customer One's filing allowance.
  await page.getByRole("button", { name: "View as Customer Two" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Title").fill("Opening a menu moves nothing on the page");
  await page.getByLabel("Description").fill("A ticket with a status, an owner and a history.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);
  const url = new URL(page.url()).pathname;
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto(url);
  await page.getByRole("button", { name: "Take ticket and start work" }).click();
  await page.locator("details.reply-fold > summary").click();
  await page.locator("#entry-body").fill("Looking at it now.");
  await page.locator("form.reply-box button[type=submit]").click();
  await expect(page.locator("article.entry")).toHaveCount(1);
  return url;
}

// What is measured each time: everything from the title down to the last row's two lines.
const MEASURED = {
  title: "h1",
  status: "details.status-menu > summary",
  owner: "details.owner-menu > summary",
  description: ".ticket-description",
  step: ".ticket-card .next-action",
  message: "article.entry",
  replyLine: "details.reply-fold > summary",
  history: "details.history > summary",
  more: "details.more-options > summary",
};
type Name = keyof typeof MEASURED;

async function boxes(page: Page): Promise<Record<Name, { x: number; y: number }>> {
  const found = {} as Record<Name, { x: number; y: number }>;
  for (const [name, selector] of Object.entries(MEASURED) as [Name, string][]) {
    const box = await page.locator(selector).first().boundingBox();
    expect(box, selector).not.toBeNull();
    found[name] = { x: Math.round(box!.x), y: Math.round(box!.y) };
  }
  return found;
}

// Each control's details element and its line. Status and Owner float over the page, and History
// and More options show their content under the last row, so every measured line stays put.
const CASES: { name: string; details: string; line: Name }[] = [
  { name: "the Status menu", details: "details.status-menu", line: "status" },
  { name: "the Owner menu", details: "details.owner-menu", line: "owner" },
  { name: "History", details: "details.history", line: "history" },
  { name: "More options", details: "details.more-options", line: "more" },
];

// One ticket for every check, since filing is rate limited and the other journeys file too.
test("opening and closing each menu moves nothing above it or its own line", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const url = await ticketInProgress(page);

  for (const width of [1280, 390]) {
    await test.step(`at ${width} wide`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      const before = await boxes(page);
      for (const { name, details, line } of CASES) {
        const summary = page.locator(MEASURED[line]);
        await summary.click();
        await expect(page.locator(details), name).toHaveJSProperty("open", true);
        expect(await boxes(page), `${name} open`).toEqual(before);
        await summary.click();
        await expect(page.locator(details), name).toHaveJSProperty("open", false);
        expect(await boxes(page), `${name} closed`).toEqual(before);
      }
      // No sideways scroll at any width.
      const scrolls = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(scrolls).toBe(false);
    });
  }

  await test.step("pressing More options and then History opens both", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    // The second press lands where History was before the first, and still opens History.
    const history = await page.locator(MEASURED.history).boundingBox();
    await page.locator(MEASURED.more).click();
    await page.mouse.click(history!.x + 5, history!.y + history!.height / 2);
    await expect(page.locator("details.history")).toHaveJSProperty("open", true);
    await expect(page.locator("details.more-options")).toHaveJSProperty("open", true);
  });

  await test.step("pressing the message line opens it with the caret in its box", async () => {
    await page.goto(url);
    await page.locator(MEASURED.replyLine).click();
    await expect(page.locator("#entry-body")).toBeFocused();
  });
});
