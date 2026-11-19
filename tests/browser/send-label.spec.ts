import { expect, test, type Page } from "@playwright/test";

// The team's send button names who will read the message, in a real browser. Choosing
// "Internal note" makes it "Save internal note". A quick reply is always a reply to the
// customer, so pressing one switches the choice back, and the button must follow it: a button
// still reading "Save internal note" while a reply to the customer is what gets sent would name
// the wrong audience.

async function signIn(page: Page, person: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.getByText(`Signed in as ${person}`)).toBeVisible();
}

test("a quick reply switches the send button back to the customer", async ({ page }) => {
  await signIn(page, "Customer One");
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill("The send button follows a quick reply");
  await page.getByLabel("Description").fill("A ticket for the team to answer with a quick reply.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+$/);
  const ticketUrl = page.url();
  await signIn(page, "Team Member");
  await page.goto(ticketUrl);

  await page.getByLabel("Internal note, for the team only").check();
  await expect(page.getByRole("button", { name: "Save internal note" })).toBeVisible();

  await page.locator("button[data-fill=entry-body]").first().click();
  await expect(page.getByLabel("Reply to the customer")).toBeChecked();
  await expect(page.getByRole("button", { name: "Send reply to customer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save internal note" })).toHaveCount(0);
});
