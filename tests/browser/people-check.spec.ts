import { expect, test } from "@playwright/test";

// "Check this change" on the People page, in a real browser at phone width: choosing a role and
// pressing the button opens the check, which fits the screen and changes nothing.

test("at 390 wide the People page and the check of a change fit, and nothing changes", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Admin" }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText("Admin");

  const sideways = () =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  await page.goto("/people");
  expect(await sideways()).toBeLessThanOrEqual(0);
  const choice = page.getByLabel("Role of Team Member");
  const form = page.locator("table.people form", { has: choice });
  await choice.selectOption("customer");
  await form.getByRole("button", { name: "Check this change" }).click();

  await expect(page).toHaveURL(/\/people\/check\?person=dev-team-1&role=customer$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Make Team Member a customer?");
  await expect(page.locator(".role-check-happens li")).toHaveText([
    "Team Member will see only their own tickets from their next page.",
  ]);
  // The made-up people keep their roles: no button, only the way back.
  await expect(page.locator("main form")).toHaveCount(0);
  expect(await sideways()).toBeLessThanOrEqual(0);
  await page.getByRole("link", { name: "Back to People" }).click();
  await expect(page.getByLabel("Role of Team Member")).toHaveValue("team");
  await context.close();
});
