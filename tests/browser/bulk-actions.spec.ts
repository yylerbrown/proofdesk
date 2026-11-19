import { expect, test } from "@playwright/test";

// The team ticks tickets on the list and changes them together. With scripts on, the bar floats
// at the bottom of the window only while something is ticked and counts what is, so ticking a
// row moves nothing on the page; the header's box ticks every row shown.

test("a team member searches, ticks every row shown and resolves them with one reason", async ({
  page,
}) => {
  const marker = "Bulkmark";
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  for (const title of [`${marker} export is empty`, `${marker} export times out`]) {
    await page.goto("/tickets/new");
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Description").fill("It happens every time.");
    await page.getByRole("button", { name: "File ticket" }).click();
    await expect(page).toHaveURL(/\/tickets\/SUP-\d+$/);
  }

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto(`/tickets?q=${marker}`);
  const bar = page.locator("[data-bulk-bar]");
  await expect(bar).toBeHidden();

  // One row, by the keyboard: its box is a stop of its own, and Space ticks it.
  const rows = page.locator('input[name="keys"]');
  await expect(rows).toHaveCount(2);
  const tableTop = () =>
    page.locator("table.tickets").evaluate((table) => table.getBoundingClientRect().top);
  const before = await tableTop();
  await rows.first().focus();
  await page.keyboard.press("Space");
  await expect(bar).toBeVisible();
  await expect(bar.locator("[data-bulk-count]")).toHaveText("1 selected");
  // The bar floats over the bottom of the window, so the table has not moved.
  expect(await tableTop()).toBe(before);
  await expect(bar).toHaveCSS("position", "fixed");
  await page.keyboard.press("Space");
  await expect(bar).toBeHidden();
  expect(await tableTop()).toBe(before);
  await page.keyboard.press("Space");

  // Every row shown, by the mouse.
  await page.getByRole("checkbox", { name: "Tick every ticket shown" }).click();
  await expect(bar.locator("[data-bulk-count]")).toHaveText("2 selected");

  // Clear unticks every row, and the bar goes.
  await bar.getByRole("button", { name: "Clear" }).click();
  await expect(bar).toBeHidden();
  await expect(rows.first()).not.toBeChecked();
  expect(await tableTop()).toBe(before);
  await page.getByRole("checkbox", { name: "Tick every ticket shown" }).click();

  // Resolved opens its reason inside the bar, which grows upward, so the table still has not moved.
  const reason = bar.getByRole("combobox", { name: "Reason" });
  await expect(reason).toBeHidden();
  await bar.getByRole("combobox", { name: "Status" }).selectOption("resolved");
  await expect(reason).toBeVisible();
  expect(await tableTop()).toBe(before);
  await reason.selectOption("wont_fix");
  await bar.getByRole("button", { name: "Apply", exact: true }).click();

  await expect(page.getByRole("status")).toHaveText("2 moved to Resolved.");
  await expect(page).toHaveURL(new RegExp(`/tickets\\?q=${marker}$`));
  await expect(page.locator(".badge", { hasText: "Resolved" })).toHaveCount(2);
  await expect(bar).toBeHidden();
});

test("without scripts the bar sits above the table, always shown", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto("/tickets");
  const bar = page.locator("[data-bulk-bar]");
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveCSS("position", "fixed");
  await expect(bar.getByRole("button", { name: "Clear" })).toBeHidden();
  await context.close();
});
