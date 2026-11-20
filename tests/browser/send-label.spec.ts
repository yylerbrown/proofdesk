import { expect, test, type Page } from "@playwright/test";

// The team's reply box, in a real browser: two tabs directly on top of the box, "Reply to the
// customer" and "Internal note", and one button that names who will read the message. Switching
// tabs moves nothing on the page. The box starts three lines tall and grows as text is typed.

async function signIn(page: Page, person: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText(person);
}

test("the send button follows the tab, and the box grows as text is typed", async ({ page }) => {
  await signIn(page, "Customer One");
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill("The send button follows the tab");
  await page.getByLabel("Description").fill("A ticket for the team to answer.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);
  const ticketUrl = new URL(page.url()).pathname;
  await signIn(page, "Team Member");
  await page.goto(ticketUrl);
  // The box is closed until wanted.
  await page.locator("summary", { hasText: "Reply or add a note" }).click();

  const box = page.getByRole("textbox", { name: "Your message" });
  const top = () => box.evaluate((element) => element.getBoundingClientRect().top);
  const height = () => box.evaluate((element) => element.getBoundingClientRect().height);
  const before = await top();

  await page.getByRole("radio", { name: "Internal note" }).check();
  await expect(page.getByRole("button", { name: "Save internal note" })).toBeVisible();
  await expect(page.getByText("Only the team can see this.")).toBeVisible();
  expect(await top()).toBe(before);

  await page.getByRole("radio", { name: "Reply to the customer" }).check();
  await expect(page.getByRole("button", { name: "Send reply to customer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save internal note" })).toHaveCount(0);
  await expect(page.getByText("Only the team can see this.")).toBeHidden();
  expect(await top()).toBe(before);

  const empty = await height();
  await box.fill(["One line.", "Two.", "Three.", "Four.", "Five.", "Six."].join("\n"));
  expect(await height()).toBeGreaterThan(empty);
});

test("after an internal note, a reload and Back open the box on Reply to the customer", async ({
  page,
}) => {
  // Filed by the admin, so the suite stays under one person's filing limit.
  await signIn(page, "Admin");
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill("The box starts on a reply again");
  await page.getByLabel("Description").fill("A ticket for the team to answer.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);
  const ticketUrl = new URL(page.url()).pathname;
  await signIn(page, "Team Member");
  await page.goto(ticketUrl);
  await page.locator("summary", { hasText: "Reply or add a note" }).click();
  await page.getByRole("radio", { name: "Internal note" }).check();
  await page.getByRole("textbox", { name: "Your message" }).fill("Checked the logs.");
  await page.getByRole("button", { name: "Save internal note" }).click();
  await expect(page.getByText("Internal note added.")).toBeVisible();

  // A fresh load of the ticket: the box starts on a reply.
  await page.goto(ticketUrl);
  await page.reload();
  await page.locator("summary", { hasText: "Reply or add a note" }).click();
  await expect(page.getByRole("radio", { name: "Reply to the customer" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Send reply to customer" })).toBeVisible();

  // Choosing a note, leaving and coming back with Back: the box starts on a reply again.
  await page.getByRole("radio", { name: "Internal note" }).check();
  await page.goto("/tickets");
  await page.goBack();
  // The box is closed again, so the choice is read from the page itself.
  await expect(page.locator('input[name="kind"][value="reply"]')).toBeChecked();
  await expect(page.locator('input[name="kind"][value="note"]')).not.toBeChecked();
  await expect(page.locator("button[data-label-reply]")).toHaveText("Send reply to customer");
});
