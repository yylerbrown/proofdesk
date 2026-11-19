import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// A ticket waiting for the customer's answer: what the "Did this fix it?" box shows, what a
// refused form says, and what archiving does to the open question.

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
  const start = html.indexOf('<article class="ticket-card" id="did-this-fix-it">');
  return start === -1 ? "" : html.slice(start, html.indexOf("</article>", start));
}

describe("the 'Did this fix it?' box", () => {
  it("quotes the customer's own words, with the team's check as one quiet line under them", async () => {
    const { app } = await waiting();
    const shown = box((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(shown).toContain(words);
    expect(shown).not.toContain("In your words");
    expect(shown).not.toContain("Use these words as my check");
    const quiet = parse(`<div>${shown}</div>`).querySelector("blockquote + .card-team-check");
    expect(quiet?.text).toBe(`Team's check: ${tighter}`);
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
