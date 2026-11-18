import { expect, test } from "@playwright/test";

// The first stops on a page, in a real browser: the skip link shows when it has focus and lands
// on the main part, Space follows a link that acts as a button, and the focus ring on a filter
// segment fits inside the row that scrolls sideways.

test("skip link, Space on button links, and the filter row's focus ring", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  await expect(page).toHaveURL(/\/tickets$/);

  await test.step("the first Tab shows the skip link, and after Enter the next Tab is in main", async () => {
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
    // main does not take focus itself; the link moves where the next Tab starts from.
    await page.keyboard.press("Tab");
    const inMain = await page.evaluate(() => document.activeElement?.closest("main#main") !== null);
    expect(inMain).toBe(true);
  });

  await test.step("the filter row leaves room for the ring around each segment", async () => {
    const row = page.locator('nav[aria-label="Filter by status"]');
    const first = row.locator("a").first();
    await first.focus();
    const rowBox = (await row.boundingBox())!;
    const linkBox = (await first.boundingBox())!;
    // The ring is 2px wide and 2px out, so 4px of the row must show on every side.
    expect(linkBox.x - rowBox.x).toBeGreaterThanOrEqual(4);
    expect(linkBox.y - rowBox.y).toBeGreaterThanOrEqual(4);
    expect(rowBox.y + rowBox.height - (linkBox.y + linkBox.height)).toBeGreaterThanOrEqual(4);
  });

  await test.step("Space on New ticket opens the form", async () => {
    await page.getByRole("button", { name: "New ticket" }).focus();
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(/\/tickets\/new(\?|$)/);
  });
});
