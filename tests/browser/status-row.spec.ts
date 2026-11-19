import { expect, test, type Locator } from "@playwright/test";

// The status row in a real browser: pressing Resolved opens the reason form under the row while
// all three buttons keep their place and size, and the reason starts on "Fixed, not yet
// confirmed", so resolving takes two presses.

/** Where a button sits and how big it is, rounded to whole pixels. */
async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("The button is not on the page.");
  return [found.x, found.y, found.width, found.height].map(Math.round);
}

test("Resolved opens its form under the row, and resolving takes two presses", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Title").fill("The status row stays still");
  await page.getByLabel("Description").fill("A ticket for the team to resolve from the row.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+$/);
  const ticketUrl = page.url();

  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto(ticketUrl);

  const row = page.locator(".status-row");
  const inProgress = row.getByRole("button", { name: "In Progress" });
  const resolved = row.locator("details.resolve > summary");
  const before = [await box(inProgress), await box(resolved)];

  await resolved.click();
  const reason = row.getByRole("combobox", { name: "Reason" });
  await expect(reason).toBeVisible();
  expect([await box(inProgress), await box(resolved)]).toEqual(before);
  // The form starts on its own line, under the buttons.
  const [, buttonTop, , buttonHeight] = before[1]!;
  expect((await box(reason))[1]!).toBeGreaterThan(buttonTop! + buttonHeight!);
  await expect(reason).toHaveValue("fixed_no_reply");

  await row.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.locator(".resolution-label")).toHaveText(
    "Resolved by the team: Fixed, not yet confirmed",
  );
});
