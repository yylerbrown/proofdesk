import { expect, test, type Page } from "@playwright/test";

// Where keyboard focus goes, in a real browser. After an action the saved line at the top has
// focus, so a screen reader reads it and the next Tab goes on from there; a reply lands on the
// line that says it was sent, by the message box, with focus on it; a search puts focus back in
// the search box. A control reached
// with Shift+Tab is never left under the sticky header. Escape closes the Resolve and Reopen
// panels and returns focus to them.

async function signIn(page: Page, person: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText(person);
}

/** Describes the focused element, so a failure says where focus went. */
function focused(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return "the page itself";
    return `${element.tagName} "${element.textContent?.trim().slice(0, 40)}"`;
  });
}

test("focus starts from the saved line, the sent line or the search box", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, "Customer One");
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill("Focus lands on the saved line");
  await page.getByLabel("Description").fill("A ticket for the focus test to file and answer.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+$/);
  const ticketUrl = page.url();

  await test.step("after filing, the saved line has focus and Tab goes on below it", async () => {
    const saved = page.locator('main > p[role="status"]');
    await expect(saved).toHaveText(
      /^Ticket SUP-\d+ filed\. The support team has it now; come back to this page for updates\.$/,
    );
    await expect(saved).toBeFocused();
    await expect(saved).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("Tab");
    const inHeader = await page.evaluate(() => document.activeElement?.closest("header") !== null);
    expect(inHeader, await focused(page)).toBe(false);
  });

  await test.step("a reply lands on the sent line by the message box, which has focus", async () => {
    await page.locator("#entry-body").fill("A reply that lands on the conversation.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/#sent$/);
    const sent = page.locator('p#sent[role="status"]');
    await expect(sent).toHaveText("Reply sent.");
    await expect(sent).toBeFocused();
    await expect(sent).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  await test.step("after a search, focus is back in the search box", async () => {
    await page.goto("/tickets");
    const search = page.getByRole("searchbox", { name: "Search titles and descriptions" });
    await search.fill("saved line");
    await search.press("Enter");
    await expect(page).toHaveURL(/q=saved/);
    await expect(search).toBeFocused();
    // The cursor sits after the old words, so typing adds to them in every browser.
    await page.keyboard.type(" here");
    await expect(search).toHaveValue("saved line here");
  });

  await test.step("a plain visit leaves focus where the browser puts it", async () => {
    await page.goto(ticketUrl);
    expect(await focused(page)).toBe("the page itself");
  });
});

test("the team's ticket page: Shift+Tab, and Escape on Resolve and Reopen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, "Customer One");
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill("The team's keyboard on a long ticket page");
  await page.getByLabel("Description").fill("A ticket for the team to reach by keyboard.");
  await page.getByRole("button", { name: "File ticket" }).click();
  const ticketUrl = page.url();
  await signIn(page, "Team Member");
  await page.goto(ticketUrl);

  await test.step("a control reached with Shift+Tab is not left under the header", async () => {
    // A short window, so the page can scroll far enough to put Send under the header.
    await page.setViewportSize({ width: 1280, height: 300 });
    const send = page.getByRole("button", { name: "Send reply to customer" });
    const nextOne = page.locator("details.history > summary");
    const header = page.locator("body > header");
    const top = (button: typeof send) =>
      button.evaluate((element) => element.getBoundingClientRect().top);
    const headerBottom = () => header.evaluate((element) => element.getBoundingClientRect().bottom);
    // Scroll until Send sits under the sticky header, then come back to it from below.
    await send.evaluate((button) => {
      window.scrollBy(0, button.getBoundingClientRect().top - 10);
    });
    expect(await top(send)).toBeLessThan(await headerBottom());
    await nextOne.evaluate((button) => button.focus({ preventScroll: true }));
    await page.keyboard.press("Shift+Tab");
    await expect(send).toBeFocused();
    expect(await top(send)).toBeGreaterThanOrEqual(await headerBottom());
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await test.step("Escape closes Resolve and puts focus back on it", async () => {
    const resolve = page.locator("details.resolve");
    const summary = resolve.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(resolve).toHaveAttribute("open", "");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(resolve).not.toHaveAttribute("open");
    await expect(summary).toBeFocused();
  });

  await test.step("Resolve holds a form, so a click elsewhere leaves it open", async () => {
    const resolve = page.locator("details.resolve");
    await resolve.locator("summary").click();
    await expect(resolve).toHaveAttribute("open", "");
    await page.getByRole("heading", { level: 1 }).click();
    await expect(resolve).toHaveAttribute("open", "");
    await resolve.locator("summary").click();
  });

  await test.step("Escape closes Reopen and puts focus back on it", async () => {
    const resolve = page.locator("details.resolve");
    await resolve.locator("summary").click();
    await resolve.locator('select[name="reason"]').selectOption("wont_fix");
    await resolve.locator('button[type="submit"]').click();
    await expect(page.locator('main > p[role="status"]')).toBeVisible();
    const reopen = page.locator("details.reopen");
    const summary = reopen.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(reopen).toHaveAttribute("open", "");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(reopen).not.toHaveAttribute("open");
    await expect(summary).toBeFocused();
  });
});
