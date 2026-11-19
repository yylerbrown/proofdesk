import { expect, test } from "@playwright/test";

// The keyboard on a ticket page and its text fields, in a real browser: More options and Edit
// ticket work from the keyboard, and a text field shows the 2px focus ring, also when the
// server has marked it as wrong.

test("More options and Edit work from the keyboard, and text fields show a real focus ring", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();

  await test.step("a refused title keeps the focus ring", async () => {
    const title = page.getByLabel("Title");
    await title.fill("ab");
    await page.getByLabel("Description").fill("The menu test needs a ticket to open.");
    await page.getByRole("button", { name: "File ticket" }).click();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await title.focus();
    await expect(title).toHaveCSS("outline-style", "solid");
    await expect(title).toHaveCSS("outline-width", "2px");
    await title.fill("Menus close from the keyboard");
    await page.getByRole("button", { name: "File ticket" }).click();
    await expect(page).toHaveURL(/\/tickets\/SUP-\d+$/);
  });

  await test.step("Edit ticket and More options open from the keyboard", async () => {
    const more = page.locator("details.more-options");
    const summary = more.locator("summary").first();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(more).toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(more).not.toHaveAttribute("open");
    await page.getByRole("link", { name: "Edit ticket" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/tickets\/SUP-\d+\/edit$/);
  });
});
