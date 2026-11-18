import { expect, test } from "@playwright/test";

// The resolve form shows "Duplicate of" only for a duplicate, and the note once a reason is
// chosen. A box that is hidden still sends what was typed in it, and the customer sees the
// note, so the note must stay visible for every chosen reason, a duplicate included.

test("the resolve form never hides a note that would be sent", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Title").fill("Labels print blank");
  await page.getByLabel("Description").fill("Every label comes out blank since Monday.");
  await page.getByRole("button", { name: "File ticket" }).click();
  const key = /\/tickets\/([A-Z]{2,6}-\d+)$/.exec(new URL(page.url()).pathname)![1]!;

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto(`/tickets/${key}`);
  const resolve = page.locator("details.resolve");
  await resolve.locator("summary").click();
  const reason = resolve.getByRole("combobox", { name: "Reason" });
  const duplicateOf = resolve.getByRole("textbox", { name: "Duplicate of" });
  const note = resolve.getByRole("textbox", { name: "Note (needed for Other)" });

  // Nothing chosen yet: neither box shows.
  await expect(duplicateOf).toBeHidden();
  await expect(note).toBeHidden();

  await reason.selectOption("other");
  await expect(note).toBeVisible();
  await expect(duplicateOf).toBeHidden();
  await note.fill("Typed under Other.");

  // Switching to Duplicate keeps the note in view, words and all.
  await reason.selectOption("duplicate");
  await expect(duplicateOf).toBeVisible();
  await expect(note).toBeVisible();
  await expect(note).toHaveValue("Typed under Other.");
});
