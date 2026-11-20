import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page, type Route } from "@playwright/test";

// The step after filing, in a real browser: what would prove it is fixed. The page's read of
// the suggestions is answered by a tiny stand-in, so the test decides whether an assistant is
// listening and when its suggestions arrive. Saving still goes to the real server.
//
// The site lets one address file only a few tickets in ten minutes, and the other browser tests
// use up that allowance on their shared copy of the app. So this file starts its own copy, on its
// own port and database, and stops it at the end.

const port = Number(process.env.BROWSER_TEST_PORT ?? 3999) + 6;
const baseURL = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
let databaseDir: string | undefined;

test.use({ baseURL });

test.beforeAll(async () => {
  databaseDir = mkdtempSync(path.join(tmpdir(), "support-desk-proof-step-"));
  server = spawn("npx", ["tsx", "src/server/index.ts"], {
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATABASE_PATH: path.join(databaseDir, "app.db"),
      DEV_SIGN_IN: "on",
      DEMO: "off",
      TICKET_PREFIX: "SUP",
      BETTER_AUTH_SECRET: "",
      BETTER_AUTH_URL: "",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    },
  });
  // Wait up to 30 seconds for the copy to answer.
  for (let tries = 0; tries < 60; tries += 1) {
    const ready = await fetch(`${baseURL}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The copy of the app for the step did not start.");
});

test.afterAll(() => {
  server?.kill();
  if (databaseDir !== undefined) rmSync(databaseDir, { recursive: true, force: true });
});

/** Opens a fresh browser context (its own cookies) and signs in as one made-up person. */
async function signInAs(browser: Browser, person: string, width = 1280): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText(person);
  return page;
}

type Answer = {
  suggestions?: { id: number; words: string }[];
  listening?: boolean;
  automatic?: boolean;
  request?: string;
};

/** Answers the page's read with what answer() gives, and counts the reads. */
async function standInRead(page: Page, answer: (read: number) => Answer) {
  let reads = 0;
  await page.route(/\/tickets\/[A-Z]+-\d+\/check-suggestions$/, (route: Route) => {
    reads += 1;
    const now = answer(reads);
    return route.fulfill({
      json: {
        check_suggestions: (now.suggestions ?? []).map((s) => ({
          ...s,
          state: "offered",
          offered_by: { kind: "agent", name: "Helper" },
          offered_at: new Date().toISOString(),
        })),
        available: { listening: now.listening ?? false, automatic: now.automatic ?? false },
        request: now.request ?? "none",
      },
    });
  });
  return () => reads;
}

/** Answers the page's request with "waiting", and keeps what each request sent. */
async function standInRequest(page: Page) {
  const sent: string[] = [];
  await page.route(/\/check-suggestions\/request$/, (route: Route) => {
    sent.push(route.request().postData() ?? "");
    return route.fulfill({ status: 201, json: { request: "waiting" } });
  });
  return sent;
}

async function fileTicket(page: Page, title: string) {
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill("The monthly export has no rows since Monday.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);
}

const WAYS = [
  { id: 901, words: "I export this month and every row is there." },
  { id: 902, words: "The file opens in a spreadsheet." },
  { id: 903, words: "The total row matches the report." },
];

/** The room between the last "+" button and the box, and the room the stylesheet sets there. */
async function gapUnderButtons(page: Page) {
  return page.locator("form#verify-form").evaluate((form) => {
    const buttons = form.querySelectorAll("button.proof-add");
    const last = buttons[buttons.length - 1]!.getBoundingClientRect();
    const box = form.querySelector("textarea")!.getBoundingClientRect();
    const group = form.querySelector(".proof-adds")!;
    return {
      gap: Math.round(box.top - last.bottom),
      set: Math.round(parseFloat(getComputedStyle(group).marginBottom)),
    };
  });
}

test("When asked: one quiet button, then + buttons add to the box, and the box never moves down", async ({
  browser,
}) => {
  const customer = await signInAs(browser, "Customer One");
  let pressedAt = Infinity;
  const reads = await standInRead(customer, (read) => {
    if (read === 1) return { listening: true };
    // The suggestions arrive on the third read after the press.
    return read - pressedAt >= 3 ? { listening: true, suggestions: WAYS } : { request: "waiting" };
  });
  const sent = await standInRequest(customer);
  await fileTicket(customer, "Export is empty for the button");

  const step = customer.locator("form#verify-form");
  const ask = step.getByRole("button", { name: "Suggest ways to prove it" });
  await expect(ask).toBeVisible();
  // It sits on the label's line, so the box does not move when it appears.
  const box = step.getByLabel("What would prove it is fixed?");
  await box.fill("My own words");

  pressedAt = reads();
  await ask.focus();
  await customer.keyboard.press("Enter");
  await expect(step.getByText("Asking the team's AI assistant...")).toBeVisible();
  // The waiting line is announced politely, once, and its dots step under the stylesheet.
  await expect(step.locator(".proof-choices")).toHaveAttribute("aria-live", "polite");
  expect(
    await step
      .locator(".proof-asking-dot")
      .first()
      .evaluate((dot) => getComputedStyle(dot).animationName),
  ).toBe("pd-asking-dot");
  const boxTop = (await box.boundingBox())!.y;
  await expect(step.locator("button.proof-add")).toHaveCount(3);
  // The room kept while asking is let go: the box sits as close under the buttons as on a page
  // drawn with them, and never lower than while asking.
  expect((await box.boundingBox())!.y).toBeLessThanOrEqual(boxTop);
  const { gap, set } = await gapUnderButtons(customer);
  expect(Math.abs(gap - set)).toBeLessThanOrEqual(1);
  expect(sent).toEqual(["pressed=true"]);
  await expect(
    step.getByText(
      "Suggested by the team's AI assistant. Press one or more to add them to the box. Edit or remove added text in the box.",
    ),
  ).toBeVisible();
  // Focus stayed on the button, and the words typed were kept until a press.
  await expect(ask).toBeFocused();
  await expect(box).toHaveValue("My own words");

  // A press adds the words on a new line after what was typed, and marks the button added; a
  // second press of it adds nothing; deleting its words puts its "+" back.
  const second = step.getByRole("button", { name: `Add: ${WAYS[1]!.words}` });
  await expect(second).toHaveAttribute("aria-pressed", "false");
  await second.click();
  await expect(box).toHaveValue(`My own words\n${WAYS[1]!.words}`);
  await expect(second).toHaveAttribute("aria-pressed", "true");
  await second.click();
  await expect(box).toHaveValue(`My own words\n${WAYS[1]!.words}`);
  await box.fill("My own words");
  await expect(second).toHaveAttribute("aria-pressed", "false");
  // By keyboard: Tab reaches each button in order, then the box; Space presses.
  await second.focus();
  await customer.keyboard.press("Tab");
  await expect(step.getByRole("button", { name: `Add: ${WAYS[2]!.words}` })).toBeFocused();
  await customer.keyboard.press("Space");
  await customer.keyboard.press("Tab");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(`My own words\n${WAYS[2]!.words}`);

  await step.getByRole("button", { name: "Save" }).click();
  await expect(customer).toHaveURL(/\/tickets\/SUP-\d+$/);
  await expect(customer.locator(".ticket-card blockquote")).toHaveText(
    `My own words\n${WAYS[2]!.words}`,
  );
  await customer.context().close();
});

// The two tests below share one ticket, still New and saying nothing yet, to file fewer.
let quietTicket = "";

test("at 390 wide, with nothing listening: no button, no assistant, and box, Save, Skip in order", async ({
  browser,
}) => {
  const customer = await signInAs(browser, "Customer One", 390);
  const reads = await standInRead(customer, () => ({}));
  await fileTicket(customer, "Export is empty with nobody listening");
  quietTicket = new URL(customer.url()).pathname;
  await expect.poll(reads).toBeGreaterThan(0);
  await expect(customer.locator("main")).not.toContainText(/assistant/i);
  const step = customer.locator("form#verify-form");
  await expect(step.locator("button")).toHaveText(["Save"]);
  const wide = await customer.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(wide).toBe(false);
  await step.getByLabel("What would prove it is fixed?").focus();
  await customer.keyboard.press("Tab");
  await expect(step.getByRole("button", { name: "Save" })).toBeFocused();
  await customer.keyboard.press("Tab");
  await expect(step.getByRole("link", { name: "Skip for now" })).toBeFocused();
  await customer.context().close();
});

test("Automatic: the page asks once by itself, then says when nothing came", async ({
  browser,
}) => {
  const customer = await signInAs(browser, "Customer One");
  await standInRead(customer, (read) =>
    read === 1 ? { listening: true, automatic: true } : { request: "expired" },
  );
  const sent = await standInRequest(customer);
  // With reduced motion the dots of "Asking..." stay still.
  await customer.emulateMedia({ reducedMotion: "reduce" });
  await customer.goto(`${quietTicket}?step=verify`);
  const step = customer.locator("form#verify-form");
  await expect(step.getByText("Asking the team's AI assistant...")).toBeVisible();
  expect(
    await step
      .locator(".proof-asking-dot")
      .first()
      .evaluate((dot) => getComputedStyle(dot).animationName),
  ).toBe("none");
  // When nothing comes, the line ends plainly instead of looping on.
  await expect(step.getByText("No suggestion this time.")).toBeVisible();
  await expect(step.locator(".proof-asking-dot")).toHaveCount(0);
  expect(sent).toEqual(["pressed=false"]);
  await expect(step.getByRole("button", { name: "Suggest ways to prove it" })).toHaveCount(0);
  // After a few seconds the line goes, and the box is as it was.
  await expect(step.getByText("No suggestion this time.")).toHaveCount(0, { timeout: 8000 });
  await customer.context().close();
});

// Choices as long as an assistant may write them: up to 200 characters each.
const LONG_WAYS = [
  {
    id: 911,
    words:
      "I export the report for this month from the reports page and the downloaded file has one row for every order I can see on screen.",
  },
  {
    id: 912,
    words:
      "The exported file opens in a spreadsheet without a warning, the columns have their headings, and the dates show as dates and not as numbers or blank cells in any of the rows.",
  },
  {
    id: 913,
    words:
      "The total at the bottom of the export matches the total the dashboard shows for the same month, to the cent, and the count of rows matches the count of orders on that page too.",
  },
];

for (const width of [390, 1280]) {
  for (const automatic of [true, false]) {
    test(`${automatic ? "Automatic" : "When asked"} at ${width} wide: long choices arrive and the box never moves down`, async ({
      browser,
    }) => {
      const customer = await signInAs(browser, "Customer One", width);
      let askedAt = Infinity;
      const reads = await standInRead(customer, (read) => {
        if (read === 1) return { listening: true, automatic };
        // The suggestions arrive on the third read after asking.
        return read - askedAt >= 3
          ? { listening: true, automatic, suggestions: LONG_WAYS }
          : { request: "waiting" };
      });
      await customer.route(/\/check-suggestions\/request$/, (route: Route) => {
        askedAt = reads();
        return route.fulfill({ status: 201, json: { request: "waiting" } });
      });
      // A failed test restarts the worker and forgets the shared ticket, so file one then.
      if (quietTicket === "") {
        await fileTicket(customer, "Export is empty for the long choices");
        quietTicket = new URL(customer.url()).pathname;
      }
      await customer.goto(`${quietTicket}?step=verify`);
      const step = customer.locator("form#verify-form");
      const box = step.getByLabel("What would prove it is fixed?");
      if (!automatic) await step.getByRole("button", { name: "Suggest ways to prove it" }).click();
      await expect(step.getByText("Asking the team's AI assistant...")).toBeVisible();
      const boxTop = (await box.boundingBox())!.y;
      await expect(step.locator("button.proof-add")).toHaveCount(3);
      expect((await box.boundingBox())!.y).toBeLessThanOrEqual(boxTop);
      const { gap, set } = await gapUnderButtons(customer);
      expect(Math.abs(gap - set)).toBeLessThanOrEqual(1);
      // Each button shows at most two lines, at least 40 pixels to press, with no sideways
      // scroll; pressing one puts all its words in the box.
      for (const button of await step.locator("button.proof-add").all()) {
        const lines = await button.locator(".user-text").evaluate((words) => {
          const style = getComputedStyle(words);
          return Math.round(words.clientHeight / parseFloat(style.lineHeight));
        });
        expect(lines).toBeLessThanOrEqual(2);
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      }
      const wide = await customer.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(wide).toBe(false);
      await step.getByRole("button", { name: `Add: ${LONG_WAYS[2]!.words}` }).click();
      await expect(box).toHaveValue(LONG_WAYS[2]!.words);
      await customer.context().close();
    });
  }
}

/** The box's height in lines of its text, and whether all its text shows without scrolling. */
async function boxLines(page: Page) {
  return page.locator("#proof-words").evaluate((box) => {
    const style = getComputedStyle(box as HTMLTextAreaElement);
    const edges =
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth);
    const height = box.getBoundingClientRect().height;
    return {
      lines: Math.round((height - edges) / parseFloat(style.lineHeight)),
      allShown: box.scrollHeight <= box.clientHeight + 1,
    };
  });
}

/** Types more lines into the box, as a person would. */
async function addLines(page: Page, count: number) {
  await page.locator("#proof-words").focus();
  await page.keyboard.press("ControlOrMeta+End");
  for (let line = 1; line <= count; line += 1) {
    await page.keyboard.press("Enter");
    await page.keyboard.type(`Line ${line} of what would prove it.`);
  }
}

test("at 390 wide the box grows with its words up to about ten lines, by stylesheet or by script", async ({
  browser,
}) => {
  const customer = await signInAs(browser, "Customer One", 390);
  await fileTicket(customer, "The box grows with what would prove it");
  const stepUrl = customer.url();
  expect(await boxLines(customer)).toEqual({ lines: 3, allShown: true });
  await addLines(customer, 4);
  expect(await boxLines(customer)).toEqual({ lines: 5, allShown: true });
  await addLines(customer, 10);
  expect(await boxLines(customer)).toEqual({ lines: 10, allShown: false });

  // A browser whose stylesheet cannot size the box: the step's script does the same.
  // The page's content policy refuses a style added in the page, so this test sets it aside.
  const fallback = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 390, height: 900 },
    storageState: await customer.context().storageState(),
  });
  await fallback.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: [string, string?]) =>
      args[0] === "field-sizing"
        ? false
        : supports(...(args as [string, string]))) as typeof CSS.supports;
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = ".proof-step textarea { field-sizing: fixed !important; }";
      document.head.append(style);
    });
  });
  const page = await fallback.newPage();
  await page.goto(stepUrl);
  expect(await boxLines(page)).toEqual({ lines: 3, allShown: true });
  await addLines(page, 4);
  expect(await boxLines(page)).toEqual({ lines: 5, allShown: true });
  await addLines(page, 10);
  expect(await boxLines(page)).toEqual({ lines: 10, allShown: false });
  await fallback.close();
});
