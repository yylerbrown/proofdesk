import { describe, expect, it } from "vitest";
import { DEV_ACTORS } from "../src/server/actor.js";
import type { Db } from "../src/server/db.js";
import { composeNotice } from "../src/server/notify/compose.js";
import { collectNotices, type NotifySettings } from "../src/server/notify/outbox.js";
import { noticesFor } from "../src/server/notify/rules.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";
import { giveAddresses } from "./notify-life.js";

// When the team marks a ticket fixed, the customer's email asks "Did this fix it?" in place of
// the plain "Resolved:" email. It says where the fix is when the team said, and quotes the
// customer's own check when the ticket has one.

const SETTINGS: NotifySettings = {
  ticketPrefix: "SUP",
  siteUrl: "https://desk.test/",
  demo: false,
  mailConfigured: true,
  madeUpPeople: [],
  roleNow: (_db, id) => DEV_ACTORS.find((person) => person.id === id)?.role,
};

const marked = {
  kind: "marked_fixed" as const,
  ticketKey: "SUP-3",
  title: "Cannot sign in on my phone",
  siteUrl: "https://desk.test",
  recipientName: "Demo Customer",
  actorName: "Demo Team Member",
  publicText: "version 4.2.1",
  customerCheck: "I can sign in on my phone",
};

describe("the email for a ticket marked fixed", () => {
  it("asks the question, with where it is fixed and the customer's check", () => {
    const { subject, body } = composeNotice(marked);
    expect(subject).toBe("[SUP-3] Did this fix it? Cannot sign in on my phone");
    expect(body).toBe(
      [
        "Hello Demo Customer,",
        "",
        'Demo Team Member says ticket SUP-3, "Cannot sign in on my phone", is fixed.',
        "Fixed in: version 4.2.1",
        "",
        "You said this would prove it is fixed:",
        '"I can sign in on my phone"',
        "",
        "If it is not fixed, say so here: https://desk.test/tickets/SUP-3#did-this-fix-it",
        "If it is, you can confirm it there. If you do nothing, the ticket stays resolved.",
        "",
        "You got this email because you filed this ticket.",
      ].join("\n"),
    );
  });

  it("leaves out the Fixed in line when the team gave none", () => {
    const { body } = composeNotice({ ...marked, publicText: null });
    expect(body).not.toContain("Fixed in:");
    expect(body).toContain(
      '"Cannot sign in on my phone", is fixed.\n\nYou said this would prove it is fixed:',
    );
  });

  it("leaves out the two lines about the check when the ticket has none", () => {
    const { body } = composeNotice({ ...marked, customerCheck: null });
    expect(body).not.toContain("You said this would prove it is fixed");
    expect(body).toContain("Fixed in: version 4.2.1\n\nIf it is not fixed");
  });
});

describe("which email a team resolution sends", () => {
  const facts = {
    type: "resolved_by_team",
    actorId: teamActor.id,
    actorKind: "person" as const,
    customerId: customerOne.id,
    ownerId: teamActor.id,
    replyByFiler: null,
  };

  it("asks the question for the reason Fixed, and keeps the plain email for the others", () => {
    expect(noticesFor({ ...facts, data: { reason: "fixed_no_reply" } })).toEqual([
      { recipientId: customerOne.id, kind: "marked_fixed", audience: "customer" },
    ]);
    for (const reason of ["duplicate", "wont_fix", "cannot_reproduce", "other"]) {
      expect(noticesFor({ ...facts, data: { reason } })[0]?.kind, reason).toBe("resolved_by_team");
    }
  });
});

function bodies(db: Db): { kind: string; subject: string; body: string }[] {
  return db.prepare("SELECT kind, subject, body FROM email_outbox ORDER BY id").all() as {
    kind: string;
    subject: string;
    body: string;
  }[];
}

/** One ticket, filed with or without a check, taken, then marked fixed with or without a note. */
async function markFixed(check: string, note?: string) {
  const { app, db } = buildTestApp();
  giveAddresses(db);
  await as(app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "It jams.", fix_check: check });
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const res = await as(app, teamActor)
    .post("/api/tickets/SUP-1/resolve")
    .send({ reason: "fixed_no_reply", note });
  expect(res.status, res.text).toBe(200);
  collectNotices(db, SETTINGS);
  return bodies(db);
}

describe("the email written when the team marks a ticket fixed", () => {
  it("carries the team's version and the customer's check", async () => {
    const [notice] = await markFixed("Ten pages print", "version 4.2.1");
    expect(notice!.kind).toBe("marked_fixed");
    expect(notice!.subject).toBe("[SUP-1] Did this fix it? Printer jams");
    expect(notice!.body).toContain("Fixed in: version 4.2.1");
    expect(notice!.body).toContain('You said this would prove it is fixed:\n"Ten pages print"');
    expect(notice!.body).toContain("https://desk.test/tickets/SUP-1#did-this-fix-it");
  });

  it("has neither line when there is no version and no check", async () => {
    const [notice] = await markFixed("");
    expect(notice!.kind).toBe("marked_fixed");
    expect(notice!.body).not.toContain("Fixed in:");
    expect(notice!.body).not.toContain("You said this would prove it is fixed");
  });
});
