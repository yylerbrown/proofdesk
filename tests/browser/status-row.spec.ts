import { expect, test } from "@playwright/test";

// The Status menu in a real browser: it opens on a press and closes on Escape, with focus back
// on it. Choosing Resolved shows one small form in the next step's place, with no reason chosen
// at first, so a reason must be picked before "Resolve ticket", and Cancel puts the step back.

test("Resolved shows its form in the next step's place, and a reason must be chosen", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Title").fill("The status menu resolves with a reason");
  await page.getByLabel("Description").fill("A ticket for the team to resolve from the menu.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+$/);
  const ticketUrl = page.url();

  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto(ticketUrl);

  const status = page.locator("details.status-menu");
  const summary = status.locator("summary");
  await expect(summary).toContainText("Status");
  await expect(summary).toContainText("New");
  // By keyboard: Enter opens it, Escape closes it and leaves focus where it was.
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(status).toHaveJSProperty("open", true);
  await page.keyboard.press("Escape");
  await expect(status).toHaveJSProperty("open", false);
  await expect(summary).toBeFocused();
  // Opening Owner closes Status: only one is open at a time.
  await summary.click();
  await page.locator("details.owner-menu summary").click();
  await expect(status).toHaveJSProperty("open", false);

  // Cancel puts the usual next step back.
  await summary.click();
  await status.getByRole("link", { name: "Resolved" }).click();
  await page.locator("form#resolve-form").getByRole("link", { name: "Cancel" }).click();
  await expect(page.locator("form#resolve-form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Take ticket and start work" })).toBeVisible();

  await summary.click();
  await status.getByRole("link", { name: "Resolved" }).click();
  const form = page.locator("form#resolve-form");
  await expect(
    form.getByRole("group", { name: "Why are you resolving this ticket?" }),
  ).toBeVisible();
  await expect(page.locator(".next-action")).toHaveCount(0);
  // No reason is chosen at first, and the browser will not send the form without one.
  await expect(form.getByRole("radio", { checked: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Resolve ticket" }).click();
  await expect(page).toHaveURL(/\?step=resolve#resolve-form$/);
  // Fixed also tells the customer, and its choice says so; the button stays Resolve ticket.
  await form.getByRole("radio", { name: "Fixed (the customer is told)" }).check();
  await form.getByRole("button", { name: "Resolve ticket" }).click();
  await expect(page.locator(".ticket-card .card-line")).toContainText(
    "Resolved by the team: Fixed.",
  );
  await expect(page.locator(".ticket-card .card-line")).toContainText(
    "The customer has not confirmed it.",
  );
});
