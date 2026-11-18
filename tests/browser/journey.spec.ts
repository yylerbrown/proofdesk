import { expect, test, type Browser, type Page } from "@playwright/test";

// One journey, end to end, the way two people would walk it in two browsers: a customer
// files a ticket with their own check, a team member owns and works it, the customer says
// No once and Yes the second time. Then a second customer tries to open the ticket.
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
const tryUrl = "https://desk.example.test/reports";

/** Opens a fresh browser context (its own cookies) and signs in as one made-up person. */
async function signInAs(browser: Browser, person: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.getByText(`Signed in as ${person}`)).toBeVisible();
  return page;
}

/** The row of the ticket list that holds this ticket. */
function listRow(page: Page, key: string) {
  return page.getByRole("row").filter({ has: page.getByRole("link", { name: key, exact: true }) });
}

/** The line under the ticket's title: its key, then its status. */
async function expectTicketStatus(page: Page, key: string, status: string) {
  await expect(page.getByRole("main")).toContainText(`${key} ${status}`);
}

/** The banner a page shows after a form saved something. */
function savedMessage(page: Page) {
  return page.getByRole("status");
}

test("a customer files a ticket, the team works it, and only the customer resolves it", async ({
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

    await expect(savedMessage(customer)).toContainText("Ticket filed");
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

    await team.getByRole("button", { name: "Take this ticket" }).click();
    await expect(savedMessage(team)).toContainText("You own this ticket now");
    await expect(team.getByRole("main")).toContainText("owner Team Member");

    await team.getByRole("combobox", { name: "Status" }).selectOption({ label: "In Progress" });
    await team.getByRole("button", { name: "Change status" }).click();
    await expect(savedMessage(team)).toContainText("Status changed");
    await expectTicketStatus(team, key, "In Progress");
  });

  await test.step("the team member replies, adds an internal note and links the change", async () => {
    await team.getByRole("radio", { name: "Reply to the customer" }).check();
    await team.getByLabel("Your message").fill(reply);
    await team.getByRole("button", { name: "Send" }).click();
    await expect(savedMessage(team)).toContainText("Reply sent");

    await team.getByRole("radio", { name: "Internal note, for the team only" }).check();
    await team.getByLabel("Your message").fill(note);
    await team.getByRole("button", { name: "Send" }).click();
    await expect(savedMessage(team)).toContainText("Internal note added");
    await expect(team.getByText(note)).toBeVisible();

    await team.getByRole("textbox", { name: "Link to the code change" }).fill(changeUrl);
    await team.getByRole("button", { name: "Save change link" }).click();
    await expect(savedMessage(team)).toContainText("Change link saved");
    await expect(team.getByRole("link", { name: changeUrl })).toBeVisible();
  });

  await test.step("the team member asks the customer to check", async () => {
    await team.getByRole("textbox", { name: "Page on the live site to try" }).fill(tryUrl);
    await team.getByRole("button", { name: "Ask the customer" }).click();
    await expect(savedMessage(team)).toContainText("asked to check the fix");
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
    await expect(question.getByRole("link", { name: tryUrl })).toBeVisible();

    await question.getByLabel("No, it is not fixed. What is still wrong?").fill(notFixedComment);
    await question.getByRole("button", { name: "No, send it back" }).click();
    await expect(savedMessage(customer)).toContainText("back with the team");
    await expect(customer.getByRole("heading", { name: "Did this fix it?" })).toHaveCount(0);
    await expectTicketStatus(customer, key, "In Progress");
  });

  await test.step("the ticket is back with the team member, with the customer's words", async () => {
    await team.goto(`/tickets/${key}`);
    await expectTicketStatus(team, key, "In Progress");
    await expect(team.getByRole("main")).toContainText("owner Team Member");
    await expect(team.getByText(notFixedComment)).toBeVisible();
    await team.goto("/tickets");
    await expect(listRow(team, key)).toContainText("Team");
  });

  await test.step("the team member asks again and the customer answers Yes", async () => {
    await team.goto(`/tickets/${key}`);
    await team.getByRole("textbox", { name: "Page on the live site to try" }).fill(tryUrl);
    await team.getByRole("button", { name: "Ask the customer" }).click();
    await expect(savedMessage(team)).toContainText("asked to check the fix");

    await customer.goto(`/tickets/${key}`);
    const question = customer
      .getByRole("article")
      .filter({ has: customer.getByRole("heading", { name: "Did this fix it?" }) });
    await expect(question.getByText(ticket.check)).toBeVisible();
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
