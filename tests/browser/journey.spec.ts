import { expect, test, type Browser, type Page } from "@playwright/test";

// Three journeys, end to end, the way two people would walk them in two browsers. The short one
// is the basics: a customer files a ticket, a team member takes it and asks the customer in one
// press, and the customer answers Yes. The plain one uses the Status menu: In Progress, then
// Resolved with a reason. The long one adds what is optional: the customer's own
// check, a reply and a note, a change link, evidence and a message with the question; the
// customer says No once and Yes the second time. Then a second customer tries to open the ticket.
//
// Elements are found by role, label and visible words, never by CSS paths. The ticket key
// is read from the address after filing and used from then on.

const ticket = {
  title: "Export button does nothing",
  description: "I press Export on the reports page and no file is downloaded.",
  check: "Pressing Export downloads a CSV file with this month's rows.",
};
const reply = "Thanks for the report. We found the cause and are fixing it now.";
const note = "Cause: the export handler swallows a timeout. Only staff should read this.";
const notFixedComment = "The file downloads now, but it is empty.";
const changeUrl = "https://git.example.test/support-desk/pull/42";
const evidence = "Exported this month's report: 31 rows.";
const message = "Exported the report as CSV, and the file downloaded with every row.";

/** Opens a fresh browser context (its own cookies) and signs in as one made-up person. */
async function signInAs(browser: Browser, person: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText(person);
  return page;
}

/** The row of the ticket list that holds this ticket. */
function listRow(page: Page, key: string) {
  return page.getByRole("row").filter({ has: page.getByRole("link", { name: key, exact: true }) });
}

/**
 * The ticket's key, in the line above its title, and its status, in the line under the title:
 * the team's Status menu, or the customer's plain words.
 */
async function expectTicketStatus(page: Page, key: string, status: string) {
  await expect(page.locator("main .back")).toHaveText(new RegExp(`/ ${key}$`));
  const team = page.locator(".ticket-facts .badge");
  if ((await team.count()) > 0) await expect(team.first()).toHaveText(status);
  else await expect(page.locator(".ticket-standing")).toHaveText(new RegExp(`^${status}`));
}

/** Opens the message box at the bottom of the ticket, which is closed until wanted. */
async function openMessageBox(page: Page) {
  await page.locator("details.reply-fold > summary").click();
}

/** The banner a page shows after a form saved something. */
// The one-time message after an action. A page with Copy buttons has a second, hidden status
// line for them, so the message is found by its own class too.
function savedMessage(page: Page) {
  return page.locator("p.saved[role=status]");
}

/** Just after asking, the ticket's card says so once, in place of the saved line. */
function askedLine(page: Page) {
  return page.locator(".ticket-card [role=status]");
}

test("the short path: file, take, ask the customer, and their Yes resolves it", async ({
  browser,
}) => {
  const customer = await signInAs(browser, "Customer One");
  const team = await signInAs(browser, "Team Member");

  await customer.getByRole("button", { name: "New ticket" }).click();
  await customer.getByLabel("Title").fill("The report page is blank");
  await customer.getByLabel("Description").fill("The reports page shows nothing since Monday.");
  await customer.getByRole("button", { name: "File ticket" }).click();
  await expect(savedMessage(customer)).toContainText(/Ticket [A-Z]{2,6}-\d+ filed\./);
  const key = /\/tickets\/([A-Z]{2,6}-\d+)$/.exec(new URL(customer.url()).pathname)![1]!;

  await team.goto(`/tickets/${key}`);
  await team.getByRole("button", { name: "Take ticket and start work" }).click();
  await expectTicketStatus(team, key, "In Progress");
  // One press marks it fixed and tells the customer: nothing else is required, no change link
  // and no customer check. The ticket is resolved at once.
  await team
    .locator(".next-action")
    .getByRole("button", { name: "Mark fixed and tell the customer" })
    .click();
  await expect(savedMessage(team)).toHaveText("Marked fixed. The customer has been told.");
  await expectTicketStatus(team, key, "Resolved");

  await customer.goto(`/tickets/${key}`);
  const question = customer
    .getByRole("article")
    .filter({ has: customer.getByRole("heading", { name: "Did this fix it?" }) });
  await question.getByRole("button", { name: "Yes, it is fixed" }).click();
  await expect(savedMessage(customer)).toContainText("The ticket is resolved");
  await expectTicketStatus(customer, key, "Resolved");
  // Only the customer's Yes reads as "Customer confirmed".
  await team.goto(`/tickets/${key}`);
  await expect(team.locator(".ticket-card .card-line")).toContainText("Customer confirmed");

  await customer.context().close();
  await team.context().close();
});

test("the plain path: the Status menu's In Progress, then Resolved with a reason", async ({
  browser,
}) => {
  const customer = await signInAs(browser, "Customer One");
  const team = await signInAs(browser, "Team Member");

  await customer.getByRole("button", { name: "New ticket" }).click();
  await customer.getByLabel("Title").fill("Labels print upside down");
  await customer.getByLabel("Description").fill("Every label prints upside down since Monday.");
  await customer.getByRole("button", { name: "File ticket" }).click();
  const key = /\/tickets\/([A-Z]{2,6}-\d+)$/.exec(new URL(customer.url()).pathname)![1]!;

  await team.goto(`/tickets/${key}`);
  const status = team.locator("details.status-menu");
  await status.locator("summary").click();
  await status.getByRole("button", { name: "In Progress (assigns it to you)" }).click();
  await expectTicketStatus(team, key, "In Progress");
  await status.locator("summary").click();
  await status.getByRole("link", { name: "Resolved" }).click();
  const resolve = team.locator("form#resolve-form");
  await resolve.getByRole("radio", { name: "Cannot reproduce" }).check();
  await resolve.getByRole("button", { name: "Resolve ticket" }).click();
  await expect(savedMessage(team)).toContainText("Resolved, with your reason");
  await expectTicketStatus(team, key, "Resolved");
  // The team's resolution is never shown as the customer's confirmation.
  await expect(team.locator(".ticket-card .card-line")).toContainText(
    "Resolved by the team: Cannot reproduce.",
  );

  await customer.context().close();
  await team.context().close();
});

test("the long path: a check, a change link and evidence, a No, then the customer's Yes", async ({
  browser,
}) => {
  const customer = await signInAs(browser, "Customer One");
  const team = await signInAs(browser, "Team Member");
  let key = "";

  await test.step("the customer files a ticket and sees it in their list", async () => {
    await customer.getByRole("button", { name: "New ticket" }).click();
    await customer.getByLabel("Title").fill(ticket.title);
    await customer.getByLabel("Description").fill(ticket.description);
    await customer.getByLabel("How will we know it's fixed?").fill(ticket.check);
    await customer.getByRole("button", { name: "File ticket" }).click();

    await expect(savedMessage(customer)).toContainText(/Ticket [A-Z]{2,6}-\d+ filed\./);
    const match = /\/tickets\/([A-Z]{2,6}-\d+)$/.exec(new URL(customer.url()).pathname);
    expect(match, "the ticket page address ends in its key").not.toBeNull();
    key = match![1]!;
    await expect(customer.getByRole("heading", { level: 1 })).toHaveText(ticket.title);
    await expectTicketStatus(customer, key, "New");

    await customer.getByRole("link", { name: "Tickets", exact: true }).click();
    await expect(listRow(customer, key)).toContainText(ticket.title);
    await expect(listRow(customer, key)).toContainText("New");
  });

  await test.step("the team member takes it and moves it to In Progress", async () => {
    await team.goto("/tickets");
    await expect(listRow(team, key)).toContainText(ticket.title);
    await expect(listRow(team, key)).toContainText("Unassigned");
    await listRow(team, key).getByRole("link", { name: key, exact: true }).click();

    // One action owns the ticket and starts work.
    await team.getByRole("button", { name: "Take ticket and start work" }).click();
    await expect(savedMessage(team)).toContainText("You own this ticket, and it is in progress");
    await expect(team.getByRole("button", { name: "Take ticket and start work" })).toHaveCount(0);
    await expectTicketStatus(team, key, "In Progress");
  });

  await test.step("the team member replies, adds a note, links the change, attaches evidence", async () => {
    await openMessageBox(team);
    await team.getByRole("radio", { name: "Reply to the customer" }).check();
    await team.getByLabel("Your message").fill(reply);
    // The one button names who will read the message.
    await team.getByRole("button", { name: "Send reply to customer" }).click();
    await expect(savedMessage(team)).toContainText("Reply sent");

    await openMessageBox(team);
    await team.getByRole("radio", { name: "Internal note" }).check();
    await expect(team.getByText("Only the team can see this.")).toBeVisible();
    await team.getByLabel("Your message").fill(note);
    await team.getByRole("button", { name: "Save internal note" }).click();
    await expect(savedMessage(team)).toContainText("Internal note added");
    await expect(team.getByText(note)).toBeVisible();

    // Both are optional evidence, added from More options. A link makes it a change.
    await team.locator("summary", { hasText: "More options" }).click();
    await team.locator("summary", { hasText: "Add evidence" }).click();
    await team.getByRole("textbox", { name: "What does it show?" }).fill("The code change");
    await team.getByRole("textbox", { name: "Link (optional)" }).fill(changeUrl);
    await team.getByRole("button", { name: "Add evidence" }).click();
    await expect(savedMessage(team)).toContainText("Evidence added");
    await team.locator("summary", { hasText: "Evidence (1)" }).click();
    await expect(team.getByRole("link", { name: changeUrl })).toBeVisible();

    await team.locator("summary", { hasText: "More options" }).click();
    await team.locator("summary", { hasText: "Add evidence" }).click();
    await team.getByRole("textbox", { name: "What does it show?" }).fill(evidence);
    await team.getByRole("button", { name: "Add evidence" }).click();
    await expect(savedMessage(team)).toContainText("Evidence added");
  });

  await test.step("the team member asks the customer to check", async () => {
    // The details are optional, so they wait behind their own disclosure: one message.
    await team.locator("summary", { hasText: "More options" }).click();
    await team.locator("summary", { hasText: "Ask before resolving" }).click();
    await team.getByRole("textbox", { name: "Message to the customer (optional)" }).fill(message);
    await team.locator("#ask form").getByRole("button", { name: "Ask the customer" }).click();
    await expect(askedLine(team)).toHaveText("Asked the customer: Did this fix it?");
  });

  await test.step("the customer sees the reply, never the note, and answers No", async () => {
    await customer.goto(`/tickets/${key}`);
    await expect(customer.getByText(reply)).toBeVisible();
    // Not shown, and not anywhere in the page's HTML either, hidden or not.
    await expect(customer.getByText(note)).toHaveCount(0);
    expect(await customer.content()).not.toContain(note);
    await expect(customer.getByText("Internal note added")).toHaveCount(0);

    const question = customer
      .getByRole("article")
      .filter({ has: customer.getByRole("heading", { name: "Did this fix it?" }) });
    await expect(question).toBeVisible();
    await expect(question.getByText(ticket.check)).toBeVisible();
    await expect(question.getByText("Team Member wrote:")).toBeVisible();
    await expect(question.getByText(message)).toBeVisible();
    // The evidence the team showed, the change among it, is one closed line in the question.
    await question.getByText("What the team showed (2)").click();
    await expect(question.getByText(evidence)).toBeVisible();

    await question.getByText("No, it is not fixed", { exact: true }).click();
    await question.getByLabel("What is still wrong?").fill(notFixedComment);
    await question.getByRole("button", { name: "No, send it back" }).click();
    await expect(savedMessage(customer)).toContainText("back with the team");
    await expect(customer.getByRole("heading", { name: "Did this fix it?" })).toHaveCount(0);
    await expectTicketStatus(customer, key, "In Progress");
  });

  await test.step("the ticket is back with the team member, with the customer's words", async () => {
    await team.goto(`/tickets/${key}`);
    await expectTicketStatus(team, key, "In Progress");
    // The card says the customer said no, and links to their words in the conversation.
    const saidNo = team.locator(".ticket-card .card-line");
    await expect(saidNo).toContainText("The customer says it is not fixed, since");
    await saidNo.getByRole("link").click();
    await expect(team.locator("article.entry", { hasText: notFixedComment })).toBeVisible();
    await expect(team.locator(".ticket-facts .owner-menu summary")).toContainText("Team Member");
    await team.goto("/tickets");
    // Still owned by the same team member, and the list says why it is back with the team.
    await expect(listRow(team, key)).toContainText("Team Member");
    await expect(listRow(team, key)).toContainText("Customer says not fixed");
  });

  await test.step("the team member asks again and the customer answers Yes", async () => {
    await team.goto(`/tickets/${key}`);
    await team.locator("summary", { hasText: "More options" }).click();
    await team.locator("summary", { hasText: "Ask before resolving" }).click();
    // After a No, the message says what changed, and the customer reads it as that.
    await team
      .getByRole("textbox", { name: "Message to the customer (optional)" })
      .fill("Empty exports are fixed too.");
    await team.locator("#ask form").getByRole("button", { name: "Ask the customer" }).click();
    await expect(askedLine(team)).toHaveText("Asked the customer: Did this fix it?");

    await customer.goto(`/tickets/${key}`);
    const question = customer
      .getByRole("article")
      .filter({ has: customer.getByRole("heading", { name: "Did this fix it?" }) });
    await expect(question.getByText(ticket.check)).toBeVisible();
    await expect(question.getByText("What changed since you said it still fails:")).toBeVisible();
    await question.getByRole("button", { name: "Yes, it is fixed" }).click();
    await expect(savedMessage(customer)).toContainText("The ticket is resolved");
  });

  await test.step("both see the ticket as Resolved", async () => {
    for (const page of [customer, team]) {
      await page.goto(`/tickets/${key}`);
      await expectTicketStatus(page, key, "Resolved");
      await expect(page.getByRole("heading", { name: "Did this fix it?" })).toHaveCount(0);
      await page.goto("/tickets");
      await expect(listRow(page, key)).toContainText("Resolved");
    }
  });

  await test.step("a second customer cannot open the first customer's ticket", async () => {
    const other = await signInAs(browser, "Customer Two");
    await expect(listRow(other, key)).toHaveCount(0);

    const theirs = await other.goto(`/tickets/${key}`);
    const theirsHeading = await other.getByRole("heading", { level: 1 }).textContent();
    const theirsText = await other.getByRole("main").textContent();
    expect(await other.content()).not.toContain(ticket.title);

    // A key that was never used, to compare with.
    const missing = await other.goto("/tickets/SUP-99999");
    const missingHeading = await other.getByRole("heading", { level: 1 }).textContent();
    const missingText = await other.getByRole("main").textContent();

    expect(theirs?.status()).toBe(404);
    expect(missing?.status()).toBe(404);
    expect(theirsHeading).toBe(missingHeading);
    // The page repeats the key that was asked for, which tells nothing. Apart from that,
    // the two answers must be the same.
    expect(theirsText?.replaceAll(key, "SUP-99999")).toBe(missingText);
    await other.context().close();
  });

  await customer.context().close();
  await team.context().close();
});
