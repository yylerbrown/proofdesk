import { DEMO_ACTORS, type Actor } from "./actor.js";
import type { TicketService } from "./tickets/service.js";

/**
 * Made-up customers who filed some of the samples. They cannot sign in. They make the team's
 * list hold more than one customer's tickets, so a customer's own list visibly holds fewer.
 */
export const OTHER_DEMO_CUSTOMERS: Actor[] = [
  {
    id: "demo-customer-2",
    kind: "person",
    role: "customer",
    name: "Second Demo Customer",
    demo: true,
  },
  {
    id: "demo-customer-3",
    kind: "person",
    role: "customer",
    name: "Third Demo Customer",
    demo: true,
  },
];

/**
 * Fills an empty demo database with a few sample tickets, made through the ticket service
 * like any others, so their history is real. Does nothing if there are tickets already.
 */
export function seedDemo(service: TicketService): void {
  // The three demo people, in the order DEMO_ACTORS lists them.
  const customer = DEMO_ACTORS[0]!;
  const team = DEMO_ACTORS[1]!;
  // Demo people cannot archive, so the sample data has no archived ticket.
  // Archived tickets count too, or archiving every sample would make the next start seed
  // a second set.
  if (!service.hasNoTickets()) return;

  const login = service.createTicket(
    {
      title: "Cannot sign in on my phone",
      description: "The sign-in button does nothing on my phone. It works on my laptop.",
      where_url: "https://example.com/sign-in",
      fix_check: "I can sign in on my phone",
    },
    customer,
  );
  service.addEntry(login.key, { kind: "reply", body: "Which phone and browser is it?" }, team);
  service.addEntry(
    login.key,
    { kind: "note", body: "Probably the button script failing on older Safari." },
    team,
  );
  service.addEntry(login.key, { kind: "reply", body: "An older iPhone, with Safari." }, customer);
  service.takeTicket(login.key, team);
  service.changeStatus(login.key, { status: "in_progress" }, team);
  service.agreeCheck(
    login.key,
    { agreed_check: "Sign-in works on Safari on iPhone, on the oldest supported version" },
    team,
  );

  service.createTicket(
    {
      title: "Invoice shows the wrong date",
      description: "My invoice for March says February.",
      fix_check: "The invoice shows March",
    },
    customer,
  );

  service.createTicket(
    {
      title: "Password reset email never arrives",
      description:
        "I asked for a password reset three times this morning. Nothing in my inbox or in spam.",
      fix_check: "A reset email arrives within a minute of asking",
    },
    customer,
  );

  // A sample made for a visitor's own AI assistant to work on: a clear check and a small,
  // complete example it can reproduce on its own machine.
  const assistantSample = service.createTicket(
    {
      title: "Sample for your AI assistant: the total adds tax twice",
      description:
        "This is a sample ticket for trying an AI assistant. The checkout total is too high. " +
        "This is the code that computes it:\n\n" +
        "function total(price, taxRate) {\n  return price + price * taxRate + price * taxRate;\n}\n\n" +
        "total(100, 0.1) returns 120.",
      fix_check: "total(100, 0.1) returns 110, and a test shows it",
    },
    customer,
  );
  // Owned and in progress, so an assistant's request for review reaches a named person.
  service.takeAndStart(assistantSample.key, team);

  // Every status in the samples, so each filter changes the list: one the customer confirmed,
  // and one where another customer said No and it went back to its owner.
  const [second, third] = OTHER_DEMO_CUSTOMERS as [Actor, Actor];
  const receipt = service.createTicket(
    {
      title: "Receipts show the wrong currency",
      description: "My receipt says USD, but I paid in euros.",
      fix_check: "My next receipt shows EUR",
    },
    customer,
  );
  askAndAnswer(service, receipt.key, team, customer, { fixed: "yes" });

  const search = service.createTicket(
    {
      title: "Search finds nothing for an exact title",
      description: "Searching for an article's exact title shows no results.",
      fix_check: "Searching for an exact title shows that article first",
    },
    second,
  );
  askAndAnswer(service, search.key, team, second, {
    fixed: "no",
    comment: "Still nothing when the title has a comma in it.",
  });

  service.createTicket(
    {
      title: "Settings page text is hard to read in dark mode",
      description: "In dark mode the labels on the settings page are dark grey on black.",
      fix_check: "I can read every label on the settings page in dark mode",
    },
    third,
  );

  const recorded = seedRecordedRun(service, team, customer);

  // Record what was seeded, so a visitor's assistant is shown only this, never what other
  // visitors write.
  service.recordDemoSeed(assistantSample.key, recorded);
}

/** The team takes a sample, links a fix and asks; its customer answers. */
function askAndAnswer(
  service: TicketService,
  key: string,
  team: Actor,
  customer: Actor,
  answer: { fixed: "yes" } | { fixed: "no"; comment: string },
): void {
  service.takeAndStart(key, team);
  service.linkChange(key, { change_url: "https://example.com/changes/42" }, team);
  const asked = service.markReady(
    key,
    {
      try_url: "https://example.com/",
      tried: "Tried it the way the customer said.",
      result: "It works.",
    },
    team,
  );
  service.answer(key, { ...answer, ready_token: asked.ready_token }, customer);
}

/**
 * The assistant of the recorded run, as it appeared on the demo. Its name is the demo
 * connection's; it writes only here, through the seed.
 */
export const RECORDED_ASSISTANT: Actor = {
  id: "demo-recorded-assistant",
  kind: "agent",
  role: "team",
  name: "Demo visitor ea29379c",
  scopes: ["read_tickets", "write_notes", "attach_evidence", "propose_specs"],
};

/**
 * A recorded example of a real assistant run on 18 Nov 2026, on the sample made for assistants.
 * The spec, the evidence and the review request are what that assistant sent, copied from its
 * transcript in docs/assistant-run; nothing is written by hand. Nobody accepted the spec or
 * asked the customer, as in the run.
 */
function seedRecordedRun(service: TicketService, team: Actor, customer: Actor): string {
  const ticket = service.createTicket(
    {
      title: "Recorded example of a real assistant run on 18 Nov 2026: the total adds tax twice",
      description:
        "A recorded example: what one real AI assistant did on the sample ticket for assistants " +
        "on 18 Nov 2026. The spec, the evidence and the review request are exactly what it sent, " +
        "copied from its transcript, which is linked on this page.\n\n" +
        "The checkout total is too high. This is the code that computes it:\n\n" +
        "function total(price, taxRate) {\n  return price + price * taxRate + price * taxRate;\n}\n\n" +
        "total(100, 0.1) returns 120.",
      fix_check: "total(100, 0.1) returns 110, and a test shows it",
    },
    customer,
  );
  service.takeAndStart(ticket.key, team);
  service.proposeSpec(
    ticket.key,
    {
      summary:
        "Checks that the checkout total adds tax only once: a price of 100 at a 10% tax rate should total 110, not 120, and an automated test shows it.",
      scenarios: [
        {
          title: "Tax is applied once",
          given: "A price of 100 and a tax rate of 0.1",
          when: "total(100, 0.1) is called",
          then: "It returns 110",
          test_name: "fixed: total(100, 0.1) returns 110",
        },
      ],
    },
    RECORDED_ASSISTANT,
  );
  service.addEvidence(
    ticket.key,
    {
      kind: "test",
      scenario: 1,
      command: "node --test sup4/total.test.js",
      result: "3 passed, 0 failed (Node v25.2.1)",
      revision: "local scratch copy, not the product repo",
      summary:
        "Local check only: I copied the function from the ticket text, because no repository was available. The original returns 120 for total(100, 0.1), so the bug reproduces. Proposed fix `return price + price * taxRate;` returns 110 (strictEqual). This was not run against the real checkout code. Nothing has been committed or deployed.",
      report: {
        environment: "node v25.2.1, darwin",
        source_of_code: "function body copied from SUP-4 description",
        fix: "function total(price, taxRate) { return price + price * taxRate; }",
        tests: [
          { name: "original reproduces bug: total(100, 0.1) returns 120", result: "pass" },
          { name: "fixed: total(100, 0.1) returns 110", result: "pass" },
          { name: "fixed: zero tax returns the price unchanged", result: "pass" },
        ],
        totals: { tests: 3, pass: 3, fail: 0 },
        not_verified: ["the real codebase", "any other callers of total()", "the live checkout"],
      },
    },
    RECORDED_ASSISTANT,
  );
  service.requestReview(
    ticket.key,
    "Please review the evidence and the proposed spec for SUP-4.\n\nWhat I observed: I copied the function from the ticket into a local scratch file, because I had no access to the product repo. The original returns 120 for total(100, 0.1). With the tax term applied once (`return price + price * taxRate;`), it returns 110. A Node test asserts this (3/3 pass, Node v25.2.1).\n\nNot done or verified: the real checkout code is unchanged, nothing has been committed or deployed, and I haven't checked other callers of total(). Someone with repo access needs to apply the one-line fix and add the test there before the customer is asked to confirm.\n\nSpec #1 (one scenario: total(100, 0.1) returns 110) has been proposed and needs a team member to accept it.",
    RECORDED_ASSISTANT,
  );
  return ticket.key;
}
