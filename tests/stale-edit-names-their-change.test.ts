import type { Express } from "express";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// When a save is refused because someone else changed the ticket while the form was open, the
// message names only what that other person changed, with the text it has now. The form carries
// what it was opened with in hidden boxes, which word this message and are trusted for nothing
// else.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

/** Every box of the edit form as a browser would send it, hidden ones included. */
async function openForm(app: Express, who: typeof teamActor) {
  const form = parse((await as(app, who).get("/tickets/SUP-1/edit")).text).querySelector(
    'form[action="/tickets/SUP-1/edit"]',
  )!;
  const fields: Record<string, string> = {};
  for (const input of form.querySelectorAll("input[name]")) {
    fields[input.getAttribute("name")!] = input.getAttribute("value") ?? "";
  }
  for (const box of form.querySelectorAll("textarea[name]")) {
    fields[box.getAttribute("name")!] = box.text;
  }
  return fields;
}

const message = (html: string) => parse(html).querySelector("p.changed-elsewhere")?.text ?? "";

describe("the refused save's message", () => {
  it("names only what the other person changed, with its text now", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const form = await openForm(app, teamActor);
    expect(form.loaded_title).toBe("Printer jams");

    // Someone else changes only the title; this person changes only the description.
    await admin(app)
      .put("/api/tickets/SUP-1")
      .send({ ...valid, title: "Printer jams on page two" });
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ ...form, description: "Jams on every second page." });
    expect(res.status).toBe(409);
    const said = message(res.text);
    expect(said).toContain('They changed: Title, now "Printer jams on page two".');
    // The description is this person's own change, so it is not named.
    expect(said).not.toContain("Description");
    // What they typed is kept.
    expect(parse(res.text).querySelector("textarea[name=description]")?.text).toBe(
      "Jams on every second page.",
    );
  });

  it("names a box emptied by the other person, and nothing when only the status moved", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ ...valid, where_url: "https://example.com/print" });
    const form = await openForm(app, customerOne);
    await as(app, customerOne).put("/api/tickets/SUP-1").send(valid);
    const emptied = await as(app, customerOne)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ ...form, title: "Printer jams a lot" });
    expect(message(emptied.text)).toContain("They changed: Page where it happened, now empty.");

    // The form that came back is based on the ticket as it is now. Only the status moves next.
    const fresh = await openForm(app, customerOne);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const statusOnly = await as(app, customerOne)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ ...fresh, title: "Printer jams a lot" });
    expect(statusOnly.status).toBe(409);
    expect(message(statusOnly.text)).toContain(
      "None of its text changed, only something else such as its status.",
    );
  });

  it("is based on the ticket as it is now after a refusal, so saving again names nothing old", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const form = await openForm(app, teamActor);
    await admin(app)
      .put("/api/tickets/SUP-1")
      .send({ ...valid, title: "Printer jams on page two" });
    const refused = await as(app, teamActor)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ ...form, description: "Jams on every second page." });
    const loaded = parse(refused.text).querySelector("input[name=loaded_title]");
    expect(loaded?.getAttribute("value")).toBe("Printer jams on page two");
  });
});
