import { expect, test, type Page } from "@playwright/test";

// The page "Who may do what" at phone width: its table scrolls inside its own box, so the page
// itself never scrolls sideways, signed out or signed in.

async function sideways(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test("at 390 wide the page Who may do what never scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/roles");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Who may do what");
  expect(await sideways(page)).toBe(0);

  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto("/roles");
  await expect(page.getByRole("columnheader", { name: "Team member (you)" })).toBeVisible();
  expect(await sideways(page)).toBe(0);
});

// The column headings stay in view after the reader scrolls to the last row, wide and narrow.
for (const width of [1440, 390]) {
  test(`at ${width} wide the roles table keeps its column headings in view`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/roles");
    await page.locator("table.roles tbody tr").last().scrollIntoViewIfNeeded();
    const heading = page.locator("table.roles thead th").first();
    await expect(heading).toBeInViewport();
    // The heading row sits on top of the rows: the point at its middle belongs to the heading.
    const onTop = await heading.evaluate((th) => {
      const box = th.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + 4, box.top + box.height / 2);
      return hit !== null && th.contains(hit);
    });
    expect(onTop).toBe(true);
  });
}
