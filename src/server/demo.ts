import { DEMO_ACTORS, type Actor } from "./actor.js";
import type { Db } from "./db.js";
import { demoNotReady } from "./errors.js";
import { DEMO_PICTURE_LIMITS } from "./pictures/limits.js";
import { samplePicture } from "./pictures/sample.js";
import { buildKey, parseKey } from "./tickets/keys.js";
import * as repository from "./tickets/repository.js";
import type { TicketService } from "./tickets/service.js";
import type { Budget } from "./tickets/types.js";
import { seedOlderSamples } from "./demo-older-samples.js";

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

  // The other customers file some samples, so the demo customer's own list stays short.
  const [second, third] = OTHER_DEMO_CUSTOMERS as [Actor, Actor];

  // The sample for AI assistants is filed first, so it is the oldest ticket and sits low in the
  // default list, under the plain support samples a visitor sees first. The recorded assistant
  // run is filed fourth, so it has the key it had when the run was recorded, SUP-4, which the
  // run's own words name. Both keys come from this seed, which records them, so nothing else
  // names a fixed number for them.
  // A sample made for a visitor's own AI assistant to work on: a clear check and a small,
  // complete example it can reproduce on its own machine. Another customer filed it, so it
  // stays out of the demo customer's list.
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
    second,
  );
  // Owned and in progress, so an assistant's request for review reaches a named person.
  service.takeAndStart(assistantSample.key, team);

  // The one sample that does not say yet what would prove it is fixed, so the list's Proof
  // column shows a row without a mark, and its filer sees the quiet link to add one.
  service.createTicket(
    {
      title: "Invoice shows the wrong date",
      description: "My invoice for March says February.",
    },
    customer,
  );

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

  const recorded = seedRecordedRun(service, team, second);

  service.createTicket(
    {
      title: "Password reset email never arrives",
      description:
        "I asked for a password reset three times this morning. Nothing in my inbox or in spam.",
      fix_check: "A reset email arrives within a minute of asking",
    },
    customer,
  );

  // Every status in the samples, so each filter changes the list: one the customer confirmed,
  // and one where another customer said No and it went back to its owner.
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

  // The one sample with a picture: a drawing of the settings panel the customer means. The
  // demo seeds it, so everyone who can open this ticket sees it.
  service.createTicketWithPictures(
    {
      title: "Settings page text is hard to read in dark mode",
      description: "In dark mode the labels on the settings page are dark grey on black.",
      fix_check: "I can read every label on the settings page in dark mode",
    },
    { files: [samplePicture()], refused: null },
    third,
    null,
  );

  // Two samples resolved weeks ago, filed last so no other sample's key changes.
  seedOlderSamples(service, team, customer, second);

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
 * The key the sample for assistants had when the recorded run happened. The run's own words,
 * copied unchanged from its transcript, name it. The sample's key now comes from the seed.
 */
export const RECORDED_SAMPLE_KEY = "SUP-4";

/**
 * The assistant of the recorded run: a demo visitor's connection, named plainly. It writes only
 * here, through the seed.
 */
export const RECORDED_ASSISTANT: Actor = {
  id: "demo-recorded-assistant",
  kind: "agent",
  role: "team",
  name: "Demo visitor's assistant",
  scopes: ["read_tickets", "write_notes", "attach_evidence", "propose_specs"],
};

/**
 * A recorded example of a real assistant run on 18 Nov 2026, on the sample made for assistants.
 * The ticket's title and description are the customer's problem alone; where the run came from
 * is told on the run's own page. The spec, the evidence and the review request are what that
 * assistant sent, copied from its transcript in docs/assistant-run; nothing is written by hand.
 * Nobody accepted the spec or asked the customer, as in the run.
 */
function seedRecordedRun(service: TicketService, team: Actor, customer: Actor): string {
  const ticket = service.createTicket(
    {
      title: "The checkout total adds tax twice",
      description:
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

/** Everyone the demo's samples name besides the three demo people, for names and roles in History. */
export const DEMO_SEED_PEOPLE: Actor[] = [...OTHER_DEMO_CUSTOMERS, RECORDED_ASSISTANT];

/** The demo's budget: enough to try everything, too little to fill the disk. */
export const DEMO_BUDGET: Budget = {
  tickets: 200,
  entriesPerTicket: 50,
  eventsPerTicket: 100,
  evidencePerTicket: 20,
  specsPerTicket: 20,
  pictures: DEMO_PICTURE_LIMITS,
};

// ---- The record of what seeding wrote ----------------------------------------------------
// On the public demo, many visitors share the sample tickets, and each may connect their own
// assistant. An assistant must never read text another visitor wrote, so the ticket service
// shows a demo connection only what this record names. The rules that use it are in
// tickets/access.ts and tickets/public-fields.ts.

/** Where the demo's seeding record is kept in app_meta. */
export const DEMO_SEED_KEY = "demo_seeded";

/** What seeding wrote: the rows, and each sample ticket's text as first written. */
export type DemoSeed = {
  tickets: number[];
  /** The sample made for assistants: on the demo, it is handed to every visitor's connection. */
  assistant?: number;
  /** The recorded example of a real assistant run, copied from its transcript. */
  recorded?: number;
  entries: number[];
  events: number[];
  text: Record<string, Partial<repository.TicketRow>>;
};

/** What seeding wrote, recorded when the demo was seeded, or null if it was not recorded. */
export function readDemoSeed(db: Db): DemoSeed | null {
  const value = repository.getMeta(db, DEMO_SEED_KEY);
  return value === undefined ? null : (JSON.parse(value) as DemoSeed);
}

/** The seeding record, or a 503 that says assistant connections are off until it exists. */
export function requireDemoSeed(db: Db): DemoSeed {
  const seed = readDemoSeed(db);
  if (seed === null) throw demoNotReady();
  return seed;
}

/**
 * The ticket service's methods for the seeding record. logEvent is the service's own writer
 * of history entries, so the hand-off it records counts against the same budget.
 */
export function createDemoRecord(
  db: Db,
  prefix: string,
  logEvent: (event: repository.NewEvent) => void,
) {
  return {
    /**
     * Moves one sample ticket this many days into the past, since the ticket service takes its
     * times from the clock. Its History keeps the times seeding wrote: a history entry never
     * changes. Called only while seeding, before recordDemoSeed.
     */
    moveDemoSampleBack(key: string, days: number): void {
      const id = parseKey(prefix, key);
      if (id !== null) repository.moveTicketBack(db, id, days);
    },

    /**
     * Records what seeding wrote, so a demo connection can be shown only that. Called once,
     * right after the demo's sample data is created on an empty database.
     */
    recordDemoSeed(assistantKey?: string, recordedKey?: string): void {
      const text: DemoSeed["text"] = {};
      const everyTicket = { limit: 1000, offset: 0 };
      const everyone: repository.ListScope = { kind: "everyone" };
      for (const row of repository.listTickets(db, everyone, null, "open_first", everyTicket)) {
        text[String(row.id)] = {
          title: row.title,
          description: row.description,
          where_url: row.where_url,
          fix_check: row.fix_check,
          agreed_check: row.agreed_check,
          change_url: row.change_url,
          try_url: row.try_url,
        };
      }
      const assistant = assistantKey === undefined ? undefined : parseKey(prefix, assistantKey);
      // The history says the sample is handed to the demo's assistants, as a real hand-off does.
      if (assistant !== null && assistant !== undefined) {
        logEvent({
          ticketId: assistant,
          actor: "demo-team",
          actorKind: "person",
          context: null,
          type: "agent_handed",
          data: { connection: "demo assistants" },
          now: new Date().toISOString(),
        });
      }
      const seed: DemoSeed = {
        tickets: repository.allIds(db, "tickets"),
        ...(assistant === null || assistant === undefined ? {} : { assistant }),
        ...(recordedKey === undefined
          ? {}
          : { recorded: parseKey(prefix, recordedKey) ?? undefined }),
        entries: repository.allIds(db, "ticket_entries"),
        events: repository.allIds(db, "ticket_events"),
        text,
      };
      repository.insertMeta(db, DEMO_SEED_KEY, JSON.stringify(seed));
    },

    /** Whether the demo's seeding was recorded, which demo connections need. */
    hasDemoSeed(): boolean {
      return readDemoSeed(db) !== null;
    },

    /** On the demo, the key of the sample ticket made for assistants; null elsewhere. */
    assistantSampleKey(): string | null {
      const id = readDemoSeed(db)?.assistant;
      return id === undefined ? null : buildKey(prefix, id);
    },

    /** The demo's recorded example of a real assistant run, by key, or null when there is none. */
    recordedRunKey(): string | null {
      const id = readDemoSeed(db)?.recorded;
      return id === undefined ? null : buildKey(prefix, id);
    },
  };
}
