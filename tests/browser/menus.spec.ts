import { expect, test } from "@playwright/test";

// The keyboard on a ticket page and its text fields, in a real browser: the customer's Edit and
// Archive on the line under the title work from the keyboard, in that order, and a text field
// shows the 2px focus ring, also when the server has marked it as wrong.

test("Edit and Archive work from the keyboard, and text fields show a real focus ring", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();

  await test.step("a refused title keeps the focus ring", async () => {
    const title = page.getByLabel("Title");
    // The browser itself stops a title under 3 characters, so nothing is sent.
    await title.fill("ab");
    await page.getByLabel("Description").fill("The menu test needs a ticket to open.");
    await page.getByRole("button", { name: "File ticket" }).click();
    await expect(page).toHaveURL(/\/tickets\/new\?form=/);
    expect(await title.evaluate((box: HTMLInputElement) => box.validity.tooShort)).toBe(true);
    // Three spaces pass the browser, and the server, which trims them, refuses the title.
    await title.fill("   ");
    await page.getByRole("button", { name: "File ticket" }).click();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await title.focus();
    await expect(title).toHaveCSS("outline-style", "solid");
    await expect(title).toHaveCSS("outline-width", "2px");
    await title.fill("Menus close from the keyboard");
    await page.getByRole("button", { name: "File ticket" }).click();
    await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);
  });

  await test.step("Edit and Archive on the line under the title, from the keyboard", async () => {
    const line = page.locator(".ticket-standing");
    const edit = line.getByRole("link", { name: "Edit", exact: true });
    const archive = line.getByRole("link", { name: "Archive", exact: true });
    // Nothing is left for the customer's More options, so it is not on the page.
    await expect(page.locator("details.more-options")).toHaveCount(0);
    await edit.focus();
    await page.keyboard.press("Tab");
    await expect(archive).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/tickets\/SUP-\d+\/edit$/);
  });
});
