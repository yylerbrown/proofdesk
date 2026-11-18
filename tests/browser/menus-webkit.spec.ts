import { expect, test } from "@playwright/test";

// Mouse use of a ticket's More menu in WebKit, the engine behind Safari. In WebKit a mouse press
// on a button or link does not focus it, so focus moves to the nearest focusable part of the
// page around it instead. The menu must stay open through that press, or the click is lost.

test.use({ browserName: "webkit" });

test("a mouse click on a choice inside More works in WebKit", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Title").fill("More works with a mouse in WebKit");
  await page.getByLabel("Description").fill("A ticket for the team to take from the More menu.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+$/);
  const ticketUrl = page.url();

  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto(ticketUrl);

  const more = page.locator("details.more");

  await test.step("Take this ticket", async () => {
    await more.locator("summary").click();
    await expect(more).toHaveAttribute("open", "");
    await page.getByRole("button", { name: "Take this ticket" }).click();
    await expect(page.getByText("You own this ticket now.")).toBeVisible();
  });

  await test.step("Edit ticket", async () => {
    await more.locator("summary").click();
    await expect(more).toHaveAttribute("open", "");
    await more.getByRole("button", { name: "Edit ticket" }).click();
    await expect(page).toHaveURL(/\/tickets\/SUP-\d+\/edit$/);
  });
});
