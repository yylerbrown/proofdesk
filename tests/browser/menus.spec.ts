import { expect, test } from "@playwright/test";

// The keyboard around a ticket's More menu and the text fields, in a real browser: Escape and
// moving focus away close the menu, and a text field shows the 2px focus ring, also when the
// server has marked it as wrong.

test("More closes from the keyboard, and text fields show a real focus ring", async ({ page }) => {
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

  const more = page.locator("details.more");
  const summary = more.locator("summary");

  await test.step("Escape closes More and puts focus back on it", async () => {
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(more).toHaveAttribute("open", "");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(more).not.toHaveAttribute("open");
    await expect(summary).toBeFocused();
  });

  await test.step("Tab past its last choice closes More", async () => {
    await page.keyboard.press("Enter");
    await expect(more).toHaveAttribute("open", "");
    const choices = await more.locator(".more-menu :is(a, button)").count();
    for (let i = 0; i <= choices; i += 1) await page.keyboard.press("Tab");
    await expect(more).not.toHaveAttribute("open");
  });

  await test.step("a click elsewhere on the page closes More", async () => {
    await summary.click();
    await expect(more).toHaveAttribute("open", "");
    await page.getByRole("heading", { level: 1 }).click();
    await expect(more).not.toHaveAttribute("open");
  });
});
