import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";

// The card at the top of the ticket page, in a real browser: just after the ask (under "Ask
// before resolving") keyboard focus is on the card's one-time line, with no ring, in sight on a
// phone; the card's day is the visitor's own
// day, the same day the rest of the page shows; and on a phone the customer's No button has its
// words in the middle, with a gap above "No, send it back".

/** Opens a fresh browser context (its own cookies) and signs in as one made-up person. */
async function signInAs(
  browser: Browser,
  person: string,
  options: BrowserContextOptions = {},
): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText(person);
  return page;
}

/**
 * A ticket the customer files and the team takes and asks about, the team in a window of the
 * given options. Returns its address.
 */
async function askedTicket(
  browser: Browser,
  title: string,
  { description = "A ticket for the card test.", teamOptions = {} } = {} as {
    description?: string;
    teamOptions?: BrowserContextOptions;
  },
): Promise<string> {
  const customer = await signInAs(browser, "Customer One");
  await customer.goto("/tickets/new");
  await customer.getByLabel("Title").fill(title);
  await customer.getByLabel("Description").fill(description);
  await customer.getByRole("button", { name: "File ticket" }).click();
  await expect(customer).toHaveURL(/\/tickets\/SUP-\d+$/);
  const url = customer.url();
  await customer.context().close();

  const team = await signInAs(browser, "Team Member", teamOptions);
  await team.goto(url);
  await team.getByRole("button", { name: "Take ticket and start work" }).click();
  // Asking before resolving is the quiet way, under More options.
  await team.locator("summary", { hasText: "More options" }).click();
  await team.locator("summary", { hasText: "Ask before resolving" }).click();
  await team.locator("#ask form").getByRole("button", { name: "Ask the customer" }).click();
  // The one-time line on the card has focus, so a screen reader reads it.
  const asked = team.locator('.ticket-card p.card-line[role="status"]');
  await expect(asked).toHaveText("Asked the customer: Did this fix it?");
  await expect(asked).toBeFocused();
  // The line is words, not a box to type in, so it draws no focus ring; and it is in sight.
  await expect(asked).toHaveCSS("outline-style", "none");
  await expect(asked).toBeInViewport();
  await team.context().close();
  return url;
}

test("after Ask, focus is on the card's line, and its day is the visitor's own", async ({
  browser,
}) => {
  const url = await askedTicket(browser, "The card's day in a far time zone");
  // A zone fourteen hours ahead of UTC, where the day is tomorrow's for most of a UTC day.
  const team = await signInAs(browser, "Team Member", { timezoneId: "Pacific/Kiritimati" });
  await team.goto(url);
  const day = team.locator(".ticket-card .card-line time[data-day]");
  await expect(day).toBeVisible();
  const shown = await day.evaluate((element) => ({
    text: element.textContent,
    local: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(element.getAttribute("datetime")!),
    ),
  }));
  expect(shown.text).toBe(shown.local);
  // The day reads inside the sentence, with no gap or break of its own around it.
  expect(await team.locator(".ticket-card .card-line").innerText()).toBe(
    `Waiting for the customer's answer. Asked ${shown.local}.`,
  );
  // The History's entry for the same question names the same day.
  await team.locator("details.history > summary").click();
  const asked = team.locator("details.history tr", { hasText: "Ready for the customer to check" });
  await expect(asked.locator("time")).toContainText(shown.local);
  await team.context().close();
});

test("after Ask on a phone, the card's line under a long description is scrolled into sight", async ({
  browser,
}) => {
  // The visible part of a phone browser with its bars showing. On a phone the card sits under
  // the status line and the description, so a description of a few lines puts it below the first
  // screen.
  const lines = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of what happened.`);
  await askedTicket(browser, "Asked on a phone with a long description", {
    description: lines.join("\n"),
    teamOptions: { viewport: { width: 390, height: 664 } },
  });
});

test("on a phone, the customer's No has its words centred and a gap above its button", async ({
  browser,
}) => {
  const url = await askedTicket(browser, "The customer's answer on a phone");
  const customer = await signInAs(browser, "Customer One", {
    viewport: { width: 390, height: 844 },
  });
  await customer.goto(url);
  const no = customer.locator("details.answer-no");
  await no.locator("summary").click();
  await expect(no).toHaveAttribute("open", "");
  const measured = await no.evaluate((details) => {
    const summary = details.querySelector("summary")!;
    const words = document.createRange();
    words.selectNodeContents(summary);
    const box = summary.getBoundingClientRect();
    const text = words.getBoundingClientRect();
    const textarea = details.querySelector("textarea")!.getBoundingClientRect();
    const button = details.querySelector("button")!.getBoundingClientRect();
    return {
      leftGap: text.left - box.left,
      rightGap: box.right - text.right,
      topGap: text.top - box.top,
      bottomGap: box.bottom - text.bottom,
      gapAboveButton: button.top - textarea.bottom,
    };
  });
  // The words and the small arrow after them are centred together, so the words sit a little
  // left of the middle; left-aligned words would leave almost the whole box on their right.
  expect(Math.abs(measured.leftGap - measured.rightGap)).toBeLessThan(40);
  expect(Math.abs(measured.topGap - measured.bottomGap)).toBeLessThan(4);
  expect(measured.gapAboveButton).toBeGreaterThanOrEqual(8);
  await customer.context().close();
});
