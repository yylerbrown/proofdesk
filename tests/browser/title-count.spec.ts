import { expect, test } from "@playwright/test";

// A title longer than 120 characters is kept whole, with a count under it that says how far
// over it is, as the description's box does. The server then refuses it with the text kept.

test("a long title is kept whole and counted, then refused with what was typed", async ({
  page,
}) => {
  await page.goto("/sign-in");
  // The admin, so the suite stays under one person's filing limit.
  await page.getByRole("button", { name: "View as Admin" }).click();
  await page.goto("/tickets/new");
  const title = page.getByLabel("Title");
  const long = "x".repeat(131);
  await title.fill(long);
  await expect(title).toHaveValue(long);
  await expect(page.locator("#title-count")).toHaveText("131 of 120 characters, 11 over.");
  await page.getByLabel("Description").fill("A ticket with a long title.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page.getByText("Must be at most 120 characters.")).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue(long);
  await expect(page.locator("#title-count")).toHaveText("131 of 120 characters, 11 over.");
});
