import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { collectNotices, type NotifySettings } from "../src/server/notify/outbox.js";
import { emailBodyParts } from "../src/server/pages/email-body.js";
import { DEV_ACTORS } from "../src/server/actor.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";
import { giveAddresses, ok } from "./notify-life.js";

// The email notices page shows each email as a card that reads like an email: who it went to,
// the date and a quiet tag for what happened to it, the subject in bold, and the body in the
// page's own type with its line breaks and a link to the ticket that can be pressed.

const WITH_MAIL: NotifySettings = {
  ticketPrefix: "SUP",
  siteUrl: "https://desk.test",
  demo: false,
  mailConfigured: true,
  madeUpPeople: [],
  roleNow: (_db, id) => DEV_ACTORS.find((person) => person.id === id)?.role,
};

describe("the pieces of an email's body", () => {
  it("make the email's own ticket address a link to its page, and nothing else", () => {
    const body = [
      "Hello Customer One,",
      "",
      "Check it here: https://shop.example/tickets/SUP-1?x=1",
      "Also https://other.example/tickets/SUP-2",
      "",
      "Open the ticket: https://desk.test/tickets/SUP-1",
    ].join("\n");
    const parts = emailBodyParts(body, "SUP-1");
    expect(parts.map((part) => part.text).join("")).toBe(body);
    expect(parts.filter((part) => part.href !== null)).toEqual([
      { text: "https://desk.test/tickets/SUP-1", href: "/tickets/SUP-1" },
    ]);
  });

  it("leave a body with no address as one piece of text", () => {
    expect(emailBodyParts("Hello,\n\nOn it.", "SUP-1")).toEqual([
      { text: "Hello,\n\nOn it.", href: null },
    ]);
  });
});

describe("an email on the notices page", () => {
  it("is a card with the recipient, the date, a tag, a bold subject and the body as text", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await ok(
      as(app, customerOne)
        .post("/api/tickets")
        .send({ title: "Printer jams", description: "On page two." }),
      201,
    );
    await ok(
      as(app, teamActor)
        .post("/api/tickets/SUP-1/entries")
        .send({ kind: "reply", body: "Looking at it." }),
      201,
    );
    collectNotices(db, WITH_MAIL);
    const page = parse((await ok(as(app, customerOne).get("/tickets/SUP-1/notices"))).text);
    const card = page.querySelector("main article.email")!;
    expect(card.querySelector("header .email-to")?.text).toBe("To You");
    expect(card.querySelector("header .email-when time")).not.toBeNull();
    expect(card.querySelector("header .email-state")?.text).toBe("Waiting to be sent");
    expect(card.querySelector(".email-subject")?.text).toBe("[SUP-1] New reply: Printer jams");
    // The body is in the page's own type, not a block of code, and keeps its line breaks.
    expect(page.querySelector("main pre")).toBeNull();
    const body = card.querySelector(".email-body")!;
    expect(body.text).toContain("Hello Customer One,\n\n");
    expect(body.text).toContain("Looking at it.");
    const links = body.querySelectorAll("a");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/tickets/SUP-1"]);
    expect(links[0]?.text).toBe("https://desk.test/tickets/SUP-1");
  });

  it("starts with one short line under the title", async () => {
    const { app } = buildTestApp();
    await ok(
      as(app, customerOne)
        .post("/api/tickets")
        .send({ title: "Printer jams", description: "On page two." }),
      201,
    );
    for (const [who, line] of [
      [customerOne, "What this ticket emailed you, newest first."],
      [teamActor, "What this ticket emailed its customer and owner, newest first."],
    ] as const) {
      const page = parse((await ok(as(app, who).get("/tickets/SUP-1/notices"))).text);
      expect(page.querySelector(".notices-lead")?.text, who.id).toBe(line);
    }
  });
});
