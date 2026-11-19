import { expect, test } from "@playwright/test";

// The resolve form shows "Duplicate of" only for a duplicate, and the note box only for Other,
// the one reason that needs it. A box that is hidden still sends what was typed in it, so the
// page's route drops a note sent with any other reason, and no hidden words reach the customer.

test("the resolve form shows each box only for the reason that needs it", async ({ page }) => {
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
  const note = resolve.getByRole("textbox", { name: "Why?" });

  // It starts with no reason chosen: only the reason and the Resolve button show.
  await expect(reason).toHaveValue("");
  await expect(duplicateOf).toBeHidden();
  await expect(note).toBeHidden();

  await reason.selectOption("other");
  await expect(note).toBeVisible();
  await expect(duplicateOf).toBeHidden();
  await note.fill("Typed under Other.");

  await reason.selectOption("duplicate");
  await expect(duplicateOf).toBeVisible();
  await expect(note).toBeHidden();

  // Resolving with another reason leaves the hidden note behind.
  await reason.selectOption("wont_fix");
  await resolve.getByRole("button", { name: "Resolve", exact: true }).click();
  const block = page.locator("article.resolved-by-team");
  await expect(block.locator("strong")).toHaveText("Resolved by the team: Won't fix");
  await expect(block).not.toContainText("Typed under Other.");
});
