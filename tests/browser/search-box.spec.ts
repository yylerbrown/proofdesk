import { expect, test, type Page } from "@playwright/test";

// The list's search box, in a real browser: round at both ends in every view. A filtered or sorted
// list puts hidden fields ahead of the box in its form, which once left the box square on the left.

async function signIn(page: Page, person: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText(person);
}

const views = [
  "/tickets",
  "/tickets?sort=key&direction=asc",
  "/tickets?status=new",
  "/tickets?status=in_progress&owner=mine&sort=title&direction=desc",
  "/tickets?q=nothing-matches-this",
];

test("the search box is round at both ends in every view of the list", async ({ page }) => {
  await signIn(page, "Team Member");
  for (const view of views) {
    await page.goto(view);
    const box = page.getByRole("searchbox");
    const corners = await box.evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.borderTopLeftRadius,
        style.borderBottomLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
      ];
    });
    const first = corners[0] ?? "";
    expect(new Set(corners).size, `${view}: ${corners.join(" ")}`).toBe(1);
    expect(parseFloat(first), view).toBeGreaterThan(16);
    await box.focus();
    expect(await box.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)).toBe(
      first,
    );
  }
});
