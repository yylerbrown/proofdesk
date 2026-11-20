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

/** Where the search box sits against the filters' row and the list's width. */
async function searchPlace(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector(".list-filters")!.getBoundingClientRect();
    const filters = document.querySelector(".list-filter-groups")!.getBoundingClientRect();
    const box = document
      .querySelector("form.list-search input[type=search]")!
      .getBoundingClientRect();
    return {
      besideFilters: Math.abs(box.top - filters.top) < filters.height,
      leftGap: Math.round(box.left - row.left),
      rightGap: Math.round(row.right - box.right),
      width: Math.round(box.width),
      remPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

test("the search box sits at the right of the filters' row, or fills a row of its own", async ({
  page,
}) => {
  await signIn(page, "Team Member");
  for (const width of [1440, 1250, 1180, 1100, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["/tickets", "/tickets?status=open", "/tickets?status=resolved"]) {
      await page.goto(view);
      const place = await searchPlace(page);
      const where = `${width} ${view}`;
      // Its right edge is always the row's right edge, and nothing scrolls sideways.
      expect(place.rightGap, where).toBe(0);
      expect(place.sideways, where).toBe(false);
      if (place.besideFilters) {
        // Beside the filters it is a box of at most 24rem at the right end.
        expect(place.width, where).toBeLessThanOrEqual(24 * place.remPx);
        expect(place.leftGap, where).toBeGreaterThan(0);
      } else {
        // On a row of its own it is as wide as the row, never a short box alone at the right.
        expect(place.leftGap, where).toBe(0);
      }
    }
  }
  // On a wide screen the filters and the search box share one row.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tickets");
  expect((await searchPlace(page)).besideFilters).toBe(true);
});
