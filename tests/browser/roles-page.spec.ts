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
