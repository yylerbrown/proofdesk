import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { HttpError } from "../src/server/errors.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor, buildTestApp, customerOne, resolveTicket, teamActor } from "./helpers.js";

// Taking, starting, releasing and returning a ticket to New, called straight on the service.
// These are the refusals no other test reaches: a resolved ticket taken, an owner whose name
// was never stored, and a call that sends no input at all.

// A second team member, made up for these calls: the development entrance has only one.
const otherTeamMember: Actor = {
  id: "team-two",
  kind: "person",
  role: "team",
  name: "Second Member",
};

function setUp() {
  const { app, db, config } = buildTestApp();
  const service = createTicketService(db, config.ticketPrefix);
  const filed = service.createTicket(
    { title: "Printer jams", description: "On page two.", fix_check: "Ten pages print" },
    customerOne,
  );
  return { app, db, service, key: filed.key };
}

/** Gives the ticket an owner whose name was never stored, as an old row might have. */
function ownedByNameless(db: ReturnType<typeof buildTestApp>["db"], key: string, status = "new") {
  const id = Number(key.split("-")[1]);
  db.prepare("UPDATE tickets SET owner_id = ?, owner_name = NULL, status = ? WHERE id = ?").run(
    "gone-person",
    status,
    id,
  );
}

/** Runs the step and returns the refusal it throws. */
function refusal(step: () => unknown): HttpError {
  try {
    step();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("The step was not refused");
}

describe("taking a ticket", () => {
  it("refuses a resolved ticket that nobody owns as not open", async () => {
    const { app, db, service, key } = setUp();
    await resolveTicket(app, key, customerOne);
    // The customer confirmed it; clear the owner so only the resolved rule can answer.
    db.prepare("UPDATE tickets SET owner_id = NULL, owner_name = NULL WHERE id = 1").run();
    const err = refusal(() => service.takeTicket(key, teamActor));
    expect(err.status).toBe(409);
    expect(err.code).toBe("not_open");
    expect(err.message).toContain("is resolved");
  });

  it("names someone, not a blank, when the owner has no stored name", () => {
    const { db, service, key } = setUp();
    ownedByNameless(db, key);
    const err = refusal(() => service.takeTicket(key, teamActor));
    expect(err.code).toBe("already_owned");
    expect(err.message).toBe(`Someone already owns ticket ${key}.`);
  });

  it("works when called with no input at all", () => {
    const { service, key } = setUp();
    const taken = service.takeTicket(key, teamActor, undefined);
    expect(taken.owner_id).toBe(teamActor.id);
  });

  it("also accepts null as no input", () => {
    const { service, key } = setUp();
    const taken = service.takeTicket(key, teamActor, null);
    expect(taken.owner_id).toBe(teamActor.id);
  });
});

describe("taking and starting a ticket in one step", () => {
  it("names someone when the owner has no stored name", () => {
    const { db, service, key } = setUp();
    ownedByNameless(db, key);
    const err = refusal(() => service.takeAndStart(key, teamActor));
    expect(err.code).toBe("already_owned");
    expect(err.message).toBe(`Someone already owns ticket ${key}.`);
  });

  it("works when called with null as its input", () => {
    const { service, key } = setUp();
    const started = service.takeAndStart(key, teamActor, null);
    expect(started.status).toBe("in_progress");
    expect(started.owner_id).toBe(teamActor.id);
  });
});

describe("releasing a ticket", () => {
  it("says its owner when the owner has no stored name", () => {
    const { db, service, key } = setUp();
    ownedByNameless(db, key);
    const err = refusal(() => service.releaseTicket(key, teamActor));
    expect(err.status).toBe(403);
    expect(err.code).toBe("not_owner");
    expect(err.message).toContain("Only its owner,");
  });

  it("works when called with null as its input", () => {
    const { service, key } = setUp();
    service.takeTicket(key, teamActor);
    const released = service.releaseTicket(key, teamActor, null);
    expect(released.owner_id).toBeNull();
  });

  it("refuses a resolved ticket even for its owner", async () => {
    const { app, service, key } = setUp();
    await resolveTicket(app, key, customerOne);
    // The helper resolves it as the admin, who then owns it.
    const err = refusal(() => service.releaseTicket(key, adminActor));
    expect(err.code).toBe("not_open");
  });
});

describe("starting work and returning to New for someone else's ticket", () => {
  const cases: { what: string; who: Actor; status: string; asked: string; words: string }[] = [
    {
      what: "starting work",
      who: teamActor,
      status: "in_progress",
      asked: "in_progress",
      words: "Only its owner, who owns ticket",
    },
    {
      what: "returning to New",
      who: otherTeamMember,
      status: "in_progress",
      asked: "new",
      words: "or an admin can return it to New.",
    },
  ];

  it.each(cases)("$what says its owner when no name is stored", ({ who, status, asked, words }) => {
    const { db, service, key } = setUp();
    ownedByNameless(db, key, status);
    const err = refusal(() => service.changeStatus(key, { status: asked }, who));
    expect(err.status).toBe(403);
    expect(err.code).toBe("not_owner");
    expect(err.message).toContain("its owner");
    expect(err.message).toContain(words);
  });

  it("lets an admin return a ticket whose owner has no stored name", () => {
    const { db, service, key } = setUp();
    ownedByNameless(db, key, "in_progress");
    const back = service.changeStatus(key, { status: "new" }, adminActor);
    expect(back.status).toBe("new");
    expect(back.owner_id).toBeNull();
  });
});
