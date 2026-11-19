import { expect, test } from "@playwright/test";

// The team ticks tickets on the list and changes them together. With scripts on, the bar shows
// only while something is ticked and counts what is; the header's box ticks every row shown.

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
  await rows.first().focus();
  await page.keyboard.press("Space");
  await expect(bar).toBeVisible();
  await expect(bar.locator("[data-bulk-count]")).toHaveText("1 selected");

  // Every row shown, by the mouse.
  await page.getByRole("checkbox", { name: "Tick every ticket shown" }).click();
  await expect(bar.locator("[data-bulk-count]")).toHaveText("2 selected");

  const reason = bar.getByRole("combobox", { name: "Reason" });
  await expect(reason).toBeHidden();
  await bar.getByRole("combobox", { name: "Status" }).selectOption("resolved");
  await expect(reason).toBeVisible();
  await reason.selectOption("wont_fix");
  await bar.getByRole("button", { name: "Apply status" }).click();

  await expect(page.getByRole("status")).toHaveText("2 moved to Resolved.");
  await expect(page).toHaveURL(new RegExp(`/tickets\\?q=${marker}$`));
  await expect(page.locator(".badge", { hasText: "Resolved" })).toHaveCount(2);
  await expect(bar).toBeHidden();
});
