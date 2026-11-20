import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { samplePicture } from "../../src/server/pictures/sample.js";

// Small things that must line up, in a real browser. The list's Filed value stays inside its
// cell's padding. The customer's "No, it is not fixed" stays beside Yes when pressed, and its
// box opens under both. The open Status menu marks the current status, and "(assigns it to
// you)" sits on the line of its words. On a phone the open Owner list starts under its button.
// Status and owner shown as plain words start on the column's edge. A picture's remove mark is
// a circle on a phone. The "Similar ticket" line on a phone shortens only the title. A line
// saved after an action, or after sending a message, is plain text with no box or ring, and the
// list heading sits close under it.

// One ticket for the whole file, with a long title, filed by Customer Two, who files little
// elsewhere, since the browser tests share one filing allowance per person.
const TITLE = "The front office printer prints every page twice since the overnight update";
const SIMILAR = "Front office printer prints every page twice";
const PHONE = { viewport: { width: 390, height: 844 } };

test.describe.configure({ mode: "serial" });

let url = "";

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

type Box = { left: number; right: number; top: number; bottom: number; width: number };

async function boxOf(page: Page, selector: string): Promise<Box> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    });
}

test.beforeAll(async ({ browser }) => {
  const customer = await signInAs(browser, "Customer Two");
  await customer.goto("/tickets/new");
  await customer.getByLabel("Title").fill(TITLE);
  await customer.getByLabel("Description").fill("Every page comes out twice.");
  await customer.getByRole("button", { name: "File ticket" }).click();
  // The step after filing: what would prove it is fixed.
  await customer.getByLabel("What would prove it is fixed?").fill("One page prints once.");
  await customer.getByRole("button", { name: "Save" }).click();
  await expect(customer).toHaveURL(/\/tickets\/SUP-\d+$/);
  url = customer.url();
  await customer.context().close();
});

test("the list's Filed value keeps the cell's right padding, even when long", async ({
  browser,
}) => {
  const team = await signInAs(browser, "Team Member", { viewport: { width: 1440, height: 900 } });
  await team.goto("/tickets");
  const gap = await team
    .locator("table.tickets tbody tr td:last-child")
    .first()
    .evaluate((cell) => {
      // The longest value the list writes, in place of "just now".
      cell.querySelector("time")!.textContent = "59 minutes ago";
      const words = document.createRange();
      words.selectNodeContents(cell);
      return cell.getBoundingClientRect().right - words.getBoundingClientRect().right;
    });
  expect(gap).toBeGreaterThanOrEqual(15);
  await team.context().close();
});

test("the open Status menu marks the current status, with its note on the line", async ({
  browser,
}) => {
  const team = await signInAs(browser, "Team Member", { viewport: { width: 1440, height: 900 } });
  await team.goto(url);
  await team.locator("details.status-menu > summary").click();
  const current = team.locator("details.status-menu .menu-current");
  await expect(current).toHaveText("New");
  const marked = await current.evaluate((element) => ({
    weight: Number(getComputedStyle(element).fontWeight),
    dot: getComputedStyle(element, "::after").width,
  }));
  expect(marked.weight).toBeGreaterThanOrEqual(600);
  expect(marked.dot).toBe("6px");
  // "In Progress" and "(assigns it to you)" share one baseline: their text boxes end together.
  const take = team.getByRole("button", { name: "In Progress (assigns it to you)" });
  const bottoms = await take.evaluate((button) => {
    const words = button.querySelector(".badge")!;
    const note = [...button.querySelector(".menu-words")!.childNodes].at(-1)!;
    const range = (node: Node) => {
      const r = document.createRange();
      r.selectNodeContents(node);
      return r.getBoundingClientRect();
    };
    return { words: range(words).bottom, note: range(note).bottom, noteText: note.textContent };
  });
  expect(bottoms.noteText).toBe(" (assigns it to you)");
  expect(Math.abs(bottoms.words - bottoms.note)).toBeLessThanOrEqual(1);
  await team.context().close();
});

test("on a phone, the open Owner list starts under its button and stays on the screen", async ({
  browser,
}) => {
  const team = await signInAs(browser, "Team Member", PHONE);
  await team.goto(url);
  await team.locator("details.owner-menu > summary").click();
  const button = await boxOf(team, "details.owner-menu > summary");
  const list = await boxOf(team, "details.owner-menu > summary + ul");
  expect(Math.abs(list.left - button.left)).toBeLessThanOrEqual(1);
  expect(list.right).toBeLessThanOrEqual(390);
  await team.context().close();
});

test("status and owner as plain words start on the column's edge, wide and on a phone", async ({
  browser,
}) => {
  // The admin takes it, so the team member can change neither its status nor its owner.
  const admin = await signInAs(browser, "Admin");
  await admin.goto(url);
  await admin.getByRole("button", { name: "Take ticket and start work" }).click();
  await expect(admin.locator(".ticket-facts .owner-menu summary")).toContainText("Admin");
  await admin.context().close();

  for (const options of [{ viewport: { width: 1440, height: 900 } }, PHONE]) {
    const team = await signInAs(browser, "Team Member", options);
    await team.goto(url);
    const facts = team.locator(".ticket-facts .fact");
    await expect(facts).toHaveCount(2);
    const title = await boxOf(team, ".ticket-page h1");
    const status = await boxOf(team, ".ticket-facts .fact >> nth=0 >> .fact-label");
    expect(status.left).toBe(title.left);
    const owner = await boxOf(team, ".ticket-facts .fact >> nth=1 >> .fact-label");
    // Beside the status, or at the edge when it has wrapped to a line of its own.
    if (owner.top > status.top) expect(owner.left).toBe(title.left);
    else expect(owner.left).toBeGreaterThan(status.right);
    await team.context().close();
  }
});

test("the customer's No stays beside Yes when pressed, and opens its box under both", async ({
  browser,
}) => {
  const admin = await signInAs(browser, "Admin");
  await admin.goto(url);
  // Taken by the admin in the test before; taken here when this test runs alone.
  const take = admin.getByRole("button", { name: "Take ticket and start work" });
  if ((await take.count()) > 0) await take.click();
  await admin.getByRole("button", { name: "Mark fixed and tell the customer" }).click();
  await expect(admin.locator("main p.saved")).toBeVisible();
  await admin.context().close();

  const customer = await signInAs(browser, "Customer Two", {
    viewport: { width: 1440, height: 900 },
  });
  await customer.goto(url);
  const yes = await boxOf(customer, ".card-answer > form button");
  const closed = await boxOf(customer, "details.answer-no > summary");
  expect(closed.left).toBeGreaterThan(yes.right);
  expect(Math.abs(closed.top - yes.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(closed.bottom - yes.bottom)).toBeLessThanOrEqual(1);
  await customer.locator("details.answer-no > summary").click();
  await expect(customer.locator("details.answer-no")).toHaveAttribute("open", "");
  const open = await boxOf(customer, "details.answer-no > summary");
  for (const side of ["left", "top", "width"] as const) {
    expect(Math.abs(open[side] - closed[side]), side).toBeLessThanOrEqual(0.5);
  }
  const form = await boxOf(customer, "details.answer-no form");
  expect(form.top).toBeGreaterThanOrEqual(Math.max(yes.bottom, open.bottom));
  expect(form.left).toBe(yes.left);
  const box = await boxOf(customer, "details.answer-no textarea");
  const send = await boxOf(customer, "details.answer-no form button");
  expect(send.top - box.bottom).toBeGreaterThanOrEqual(8);
  await customer.context().close();
});

test("on a phone, the new ticket form's picture mark is a circle and the similar line shortens only the title", async ({
  browser,
}) => {
  const customer = await signInAs(browser, "Customer Two", PHONE);
  await customer.goto("/tickets/new");
  await customer
    .locator('input[name="pictures"]')
    .setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: samplePicture() });
  const remove = await boxOf(customer, ".picture-strip button.picture-remove");
  expect(remove.width).toBe(24);
  expect(remove.bottom - remove.top).toBe(24);

  await customer.getByLabel("Title").fill(SIMILAR);
  const line = customer.locator("#title-similar");
  await expect(line).toBeVisible({ timeout: 2000 });
  await expect(line).toContainText(SIMILAR.split(" ")[1]!);
  const shown = await line.evaluate((element) => {
    const status = element.lastElementChild as HTMLElement;
    const link = element.querySelector("a")!;
    return {
      status: status.textContent,
      statusRight: status.getBoundingClientRect().right,
      lineRight: element.getBoundingClientRect().right,
      statusCut: status.scrollWidth > status.clientWidth,
      titleCut: link.scrollWidth > link.clientWidth,
    };
  });
  expect(shown.status).toMatch(/^ \((New|In Progress|Resolved)\)$/);
  expect(shown.statusRight).toBeLessThanOrEqual(shown.lineRight + 0.5);
  expect(shown.statusCut).toBe(false);
  expect(shown.titleCut).toBe(true);
  await customer.context().close();
});

test("after a change to ticked tickets, the list heading sits close under the saved line", async ({
  browser,
}) => {
  const team = await signInAs(browser, "Team Member", { viewport: { width: 1440, height: 900 } });
  await team.goto("/tickets");
  await team.locator("tbody input.bulk-tick").first().check();
  await team.locator("select[name=owner]").selectOption("me");
  await team.getByRole("button", { name: "Apply" }).click();
  await expect(team.locator("main p.saved")).toBeVisible();
  const saved = await boxOf(team, "main p.saved");
  const heading = await boxOf(team, "main h1");
  expect(heading.top - saved.bottom).toBeLessThanOrEqual(16);
  await team.context().close();
});

test("the line after sending a message is quiet text: focused for a screen reader, with no box or ring", async ({
  browser,
}) => {
  const customer = await signInAs(browser, "Customer Two");
  await customer.goto(url);
  await customer.locator("details.reply-fold > summary").click();
  await customer.locator("#entry-body").fill("It printed once this morning.");
  await customer.locator("form.reply-box button[type=submit]").click();
  const sent = customer.locator("#sent");
  await expect(sent).toBeFocused();
  await expect(sent).toHaveCSS("outline-style", "none");
  await expect(sent).toHaveCSS("border-top-style", "none");
  await expect(sent).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await customer.context().close();
});

test("between 1100 and 1250 wide the Proof column takes its room from Status, not the title", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "View as Team Member" }).click();
  for (const width of [1100, 1180, 1250]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/tickets");
    const columns = await page
      .locator("table.tickets thead th")
      .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
    const rem = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    // Status keeps only the room its longest tag needs and Proof is as wide as its header, so
    // together they are 21.25rem, down from 23rem, and the title has that room back.
    expect(columns[2]! + columns[3]!, `at ${width}px`).toBeLessThanOrEqual(21.25 * rem + 1);
    // Every status word and its tag still fit on their line, uncut.
    const cut = await page
      .locator("table.tickets td.status-cell")
      .evaluateAll((cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth).length);
    expect(cut, `at ${width}px`).toBe(0);
  }
});
