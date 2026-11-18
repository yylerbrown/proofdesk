import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/server/demo.js";
import { insertEvent } from "../src/server/tickets/repository.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, adminActor, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

const words = "It prints";
const tighter = "Ten pages, no jam";

/** Customer one's SUP-1, taken and in progress, with an agreed check, waiting for an answer. */
async function waiting() {
  const built = buildTestApp();
  await as(built.app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "Every page.", fix_check: words });
  const team = as(built.app, teamActor);
  await team.post("/api/tickets/SUP-1/take");
  await team.patch("/api/tickets/SUP-1").send({ status: "in_progress" });
  await team.put("/api/tickets/SUP-1/agreed-check").send({ agreed_check: tighter });
  await team.put("/api/tickets/SUP-1/change-link").send({ change_url: "https://example.com/c/1" });
  const ready = await team
    .post("/api/tickets/SUP-1/ready")
    .send({ try_url: "https://example.com/t", tried: "I printed ten pages.", result: "No jam." });
  return { ...built, token: ready.body.ready_token as string };
}

/** Only the "Did this fix it?" box of a page. */
function box(html: string): string {
  const start = html.indexOf('<article id="did-this-fix-it">');
  return start === -1 ? "" : html.slice(start, html.indexOf("</article>", start));
}

describe("the 'Did this fix it?' box", () => {
  it("shows the agreed check and the customer's own words, each labelled", async () => {
    const { app } = await waiting();
    const shown = box((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(shown).toContain("Team's check:");
    expect(shown).toContain(tighter);
    expect(shown).toContain("In your words:");
    expect(shown).toContain(words);
  });

  it("keeps a refused comment and says why, instead of an error page", async () => {
    const { app, token } = await waiting();
    const long = "a".repeat(5001);
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/answer")
      .type("form")
      .send({ fixed: "no", comment: long, ready_token: token });
    expect(res.status).toBe(400);
    expect(box(res.text)).toContain(`${long}</textarea>`);
    expect(box(res.text)).toContain("Must be at most 5000 characters.");
  });
});

describe("the team's forms on the ticket page", () => {
  it("say what is wrong next to the form, for a link that is not http or https", async () => {
    const { app } = await waiting();
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/change-link")
      .type("form")
      .send({ change_url: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("Must be a link that starts with http or https.");
  });
});

describe("archiving while the customer is asked", () => {
  it("withdraws the question, so it is not still open after a restore", async () => {
    const { app, token } = await waiting();
    await as(app, customerOne).post("/api/tickets/SUP-1/archive");
    await admin(app).post("/api/tickets/SUP-1/restore");
    expect((await admin(app).get("/api/tickets/SUP-1")).body.ready_at).toBeNull();
    const late = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: token });
    expect(late.status).toBe(409);
  });
});

describe("the history a customer sees", () => {
  it("hides any kind of entry not on the list of kinds they may see", async () => {
    const { app, db } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    insertEvent(db, {
      ticketId: 1,
      actor: teamActor.id,
      actorKind: "person",
      type: "something_new_about_a_note",
      data: {},
      now: new Date().toISOString(),
    });
    const theirs = await as(app, customerOne).get("/api/tickets/SUP-1/events");
    expect(theirs.body.map((e: { type: string }) => e.type)).toEqual(["created"]);
    const team = await as(app, teamActor).get("/api/tickets/SUP-1/events");
    expect(team.body).toHaveLength(2);
  });
});

describe("an agreed check that only repeats the customer", () => {
  it("is stored as none, with nothing written", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x", fix_check: words });
    const res = await as(app, teamActor)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: words });
    expect(res.body.agreed_check).toBeNull();
    expect((await admin(app).get("/api/tickets/SUP-1/events")).body).toHaveLength(1);
  });
});

describe("seeding the demo", () => {
  it("counts archived tickets, so it never seeds a second set", () => {
    const { db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(db, "SUP");
    seedDemo(service);
    const seeded = service.listTickets("all", adminActor);
    // Every sample archived, as an admin outside the demo rules could.
    for (const ticket of seeded) service.archiveTicket(ticket.key, adminActor);
    seedDemo(service);
    const count = db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number };
    expect(count.n).toBe(seeded.length);
  });
});

describe("a malformed key", () => {
  it("is not repeated back in the message", async () => {
    const { app } = buildTestApp();
    const sent = "SUP-<b>words of my choosing</b>";
    const res = await admin(app).get(`/api/tickets/${encodeURIComponent(sent)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).not.toContain("words of my choosing");
    const page = await admin(app).get(`/tickets/${encodeURIComponent(sent)}`);
    expect(page.text).not.toContain("words of my choosing");
  });
});
