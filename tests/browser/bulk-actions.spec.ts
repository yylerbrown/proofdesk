import { expect, test, type Page } from "@playwright/test";

// The team ticks tickets on the list and changes them together. With scripts on, the bar lies
// over the filter row only while something is ticked and counts what is, so ticking a row moves
// nothing on the page; the header's box ticks every row shown.

// Where an element's top edge is in the window, in pixels.
async function topOf(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => element.getBoundingClientRect().top);
}

test("a team member searches, ticks every row shown and resolves them with one reason", async ({
  page,
}) => {
  const marker = "Bulkmark";
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  for (const title of [`${marker} export is empty`, `${marker} export times out`]) {
    await page.goto("/tickets/new");
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Description").fill("It happens every time.");
    await page.getByRole("button", { name: "File ticket" }).click();
    await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);
  }

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto(`/tickets?q=${marker}`);
  const bar = page.locator("[data-bulk-bar]");
  await expect(bar).toBeHidden();

  // One row, by the keyboard: its box is a stop of its own, and Space ticks it.
  const rows = page.locator('input[name="keys"]');
  await expect(rows).toHaveCount(2);
  const tableTop = () => topOf(page, "table.tickets");
  const headingTop = () => topOf(page, "h1");
  const before = await tableTop();
  const heading = await headingTop();
  const filtersTop = await topOf(page, ".list-filters");
  await rows.first().focus();
  await page.keyboard.press("Space");
  await expect(bar).toBeVisible();
  await expect(bar.locator("[data-bulk-count]")).toHaveText("1 selected");
  // The bar lies over the filter row, so neither the heading nor the table has moved.
  expect(await tableTop()).toBe(before);
  expect(await headingTop()).toBe(heading);
  expect(Math.abs((await topOf(page, "[data-bulk-bar]")) - filtersTop)).toBeLessThanOrEqual(1);
  await expect(page.locator(".list-filters")).toBeHidden();
  await page.keyboard.press("Space");
  await expect(bar).toBeHidden();
  await expect(page.locator(".list-filters")).toBeVisible();
  expect(await tableTop()).toBe(before);
  expect(await headingTop()).toBe(heading);
  await page.keyboard.press("Space");

  // Every row shown, by the mouse.
  await page.getByRole("checkbox", { name: "Tick every ticket shown" }).click();
  await expect(bar.locator("[data-bulk-count]")).toHaveText("2 selected");

  // Clear unticks every row, and the bar goes.
  await bar.getByRole("button", { name: "Clear" }).click();
  await expect(bar).toBeHidden();
  await expect(rows.first()).not.toBeChecked();
  expect(await tableTop()).toBe(before);
  expect(await headingTop()).toBe(heading);
  await page.getByRole("checkbox", { name: "Tick every ticket shown" }).click();

  // Resolved opens its reason inside the bar, which grows down over the list if it must, so the
  // table still has not moved.
  const reason = bar.getByRole("combobox", { name: "Reason" });
  await expect(reason).toBeHidden();
  await bar.getByRole("combobox", { name: "Status" }).selectOption("resolved");
  await expect(reason).toBeVisible();
  expect(await tableTop()).toBe(before);
  expect(await headingTop()).toBe(heading);
  await reason.selectOption("wont_fix");
  await bar.getByRole("button", { name: "Apply", exact: true }).click();

  await expect(page.getByRole("status")).toHaveText("2 moved to Resolved.");
  await expect(page).toHaveURL(new RegExp(`/tickets\\?q=${marker}$`));
  await expect(page.locator(".badge", { hasText: "Resolved" })).toHaveCount(2);
  await expect(bar).toBeHidden();
});

test("the bar covers the filter row at desktop and phone width, Tab skips the filters, and a scrolled list keeps the bar in view", async ({
  page,
}) => {
  const marker = "Scrollmark";
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Customer One" }).click();
  for (const n of [1, 2, 3, 4]) {
    await page.goto("/tickets/new");
    await page.getByLabel("Title").fill(`${marker} report ${n} is late`);
    await page.getByLabel("Description").fill("It happens every time.");
    await page.getByRole("button", { name: "File ticket" }).click();
    await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);
  }
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/tickets?q=${marker}`);
    const filters = page.locator(".list-filters");
    const bar = page.locator("[data-bulk-bar]");
    const filtersBox = await filters.evaluate((element) =>
      element.getBoundingClientRect().toJSON(),
    );
    await page.locator('input[name="keys"]').first().check();
    await expect(bar).toBeVisible();
    const barBox = await bar.evaluate((element) => element.getBoundingClientRect().toJSON());
    expect(Math.abs(barBox.top - filtersBox.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(barBox.left - filtersBox.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(barBox.width - filtersBox.width)).toBeLessThanOrEqual(1);

    // Shift+Tab from the first row's box back up to the site header: the bar's controls are on
    // the way, and nothing in the covered filters is.
    await page.locator('input[name="keys"]').first().focus();
    const stops: { inFilters: boolean; name: string }[] = [];
    for (let press = 0; press < 40; press += 1) {
      await page.keyboard.press("Shift+Tab");
      const stop = await page.evaluate(() => {
        const active = document.activeElement;
        return {
          inFilters: active?.closest(".list-filters") !== null,
          inHeader: active?.closest("body > header") !== null,
          name: active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? "",
        };
      });
      if (stop.inHeader) break;
      stops.push(stop);
    }
    expect(stops.map((stop) => stop.name)).toContain("Status");
    expect(stops.filter((stop) => stop.inFilters)).toEqual([]);

    await bar.getByRole("button", { name: "Clear" }).click();
    await expect(bar).toBeHidden();
    await expect(filters).toBeVisible();
    await expect(page.getByRole("searchbox")).toBeVisible();
  }

  // At the bottom of a scrolled list, ticking and unticking the last row moves nothing.
  // A short window, so the list scrolls and the end of the page is the end of the scroll.
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.goto(`/tickets?q=${marker}`);
  const bar = page.locator("[data-bulk-bar]");
  const last = page.locator('input[name="keys"]').last();
  const lastTop = () => last.evaluate((box) => box.getBoundingClientRect().top);
  const toEnd = () => page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  await toEnd();
  const before = await lastTop();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await last.check();
  await expect(bar).toBeVisible();
  await toEnd();
  const ticked = await lastTop();
  expect(ticked).toBe(before);
  // The filter row has scrolled away under the site header, and the bar stays in the window,
  // stuck just under that header.
  const headerBottom = await page
    .locator("body > header")
    .evaluate((header) => header.getBoundingClientRect().bottom);
  const filtersBottom = await page
    .locator(".list-filters")
    .evaluate((filters) => filters.getBoundingClientRect().bottom);
  expect(filtersBottom).toBeLessThan(headerBottom);
  const barBox = await bar.evaluate((element) => element.getBoundingClientRect().toJSON());
  expect(Math.abs(barBox.top - headerBottom)).toBeLessThanOrEqual(1);
  expect(barBox.bottom).toBeLessThanOrEqual(300);
  // Resolved can grow the bar, and choosing another status again shrinks it.
  const status = bar.getByRole("combobox", { name: "Status" });
  await status.selectOption("resolved");
  await toEnd();
  expect(await lastTop()).toBe(ticked);
  await status.selectOption("new");
  expect(await lastTop()).toBe(ticked);
  await last.uncheck();
  await expect(bar).toBeHidden();
  expect(await lastTop()).toBe(ticked);
});

test("without scripts the bar sits above the table, always shown", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  await page.goto("/tickets");
  const bar = page.locator("[data-bulk-bar]");
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveCSS("position", "fixed");
  await expect(bar.getByRole("button", { name: "Clear" })).toBeHidden();
  await context.close();
});
