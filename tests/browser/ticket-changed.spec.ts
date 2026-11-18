import { expect, test } from "@playwright/test";

// A ticket page left open notices when someone else changes the ticket. The team member keeps
// the ticket open in one browser; the customer, in another, edits it. When the team member's
// tab comes back into view, one line says the ticket changed, and nothing else on the page moved.

test("an open ticket page says when the ticket changed elsewhere", async ({ browser }) => {
  const customer = await (await browser.newContext()).newPage();
  await customer.goto("/sign-in");
  await customer.getByRole("button", { name: "View as Customer One" }).click();
  await customer.getByRole("button", { name: "New ticket" }).click();
  await customer.getByLabel("Title").fill("Receipts print twice");
  await customer.getByLabel("Description").fill("Every receipt comes out two times.");
  await customer.getByRole("button", { name: "File ticket" }).click();
  const key = /\/tickets\/([A-Z]{2,6}-\d+)$/.exec(new URL(customer.url()).pathname)![1]!;

  const team = await (await browser.newContext()).newPage();
  await team.goto("/sign-in");
  await team.getByRole("button", { name: "View as Team Member" }).click();
  await team.goto(`/tickets/${key}`);
  const notice = team.getByRole("status").filter({ hasText: "This ticket changed." });
  await expect(
    team.getByRole("heading", { name: "Receipts print twice", exact: true }),
  ).toBeVisible();

  // Nothing has changed yet: coming back to the tab says nothing.
  await team.evaluate(() => window.dispatchEvent(new Event("focus")));
  await team.waitForTimeout(300);
  await expect(notice).toHaveCount(0);

  await customer.goto(`/tickets/${key}/edit`);
  await customer.getByLabel("Title").fill("Receipts print twice since Monday");
  await customer.getByRole("button", { name: "Save changes" }).click();
  await expect(customer.getByText("Changes saved.")).toBeVisible();

  await team.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(notice).toHaveText("This ticket changed. Refresh to see it.");
  // The page itself was not replaced: it still shows the title it was loaded with.
  await expect(
    team.getByRole("heading", { name: "Receipts print twice", exact: true }),
  ).toBeVisible();

  await notice.getByRole("link", { name: "Refresh" }).click();
  await expect(
    team.getByRole("heading", { name: "Receipts print twice since Monday" }),
  ).toBeVisible();
  await expect(notice).toHaveCount(0);
});
