import { expect, test } from "@playwright/test";

// Mouse use of a ticket page in WebKit, the engine behind Safari: More options opens with a
// press, and Edit ticket, the quiet link under the title, leads to the edit page.

test.use({ browserName: "webkit" });

test("More options and Edit ticket work with a mouse in WebKit", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Title").fill("More options work with a mouse in WebKit");
  await page.getByLabel("Description").fill("A ticket for the team to open and edit.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+$/);
  const ticketUrl = page.url();

  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto(ticketUrl);

  await test.step("More options", async () => {
    const more = page.locator("details.more-options");
    await more.locator("summary").first().click();
    await expect(more).toHaveAttribute("open", "");
    await expect(more.locator("summary", { hasText: "Attach evidence" })).toBeVisible();
  });

  await test.step("Edit ticket", async () => {
    await page.getByRole("link", { name: "Edit ticket" }).click();
    await expect(page).toHaveURL(/\/tickets\/SUP-\d+\/edit$/);
  });
});
