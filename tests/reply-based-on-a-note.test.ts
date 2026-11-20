import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Only someone who may read internal notes may publish a reply from one. Anyone else is refused
// with the same words whatever number they send, so a reply never links to a note, and the
// answer never says whether a number belongs to a note.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

describe("a reply based on a note", () => {
  it("is refused from a customer, the same way for a note and for any other number", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const note = (
      await as(app, teamActor)
        .post("/api/tickets/SUP-1/entries")
        .send({ kind: "note", body: "Internal: the driver is old." })
    ).body as { id: number };

    const onNote = await as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "Any news?", based_on: note.id });
    const onNothing = await as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "Any news?", based_on: note.id + 100 });

    expect(onNote.status).toBe(400);
    expect(onNote.body).toEqual(onNothing.body);
    expect(JSON.stringify(onNote.body)).not.toContain(String(note.id));
    // Nothing was written.
    const entries = (await as(app, customerOne).get("/api/tickets/SUP-1/entries")).body as {
      kind: string;
    }[];
    expect(entries.filter((e) => e.kind === "reply")).toHaveLength(0);
  });

  it("still works for the team", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const note = (
      await as(app, teamActor)
        .post("/api/tickets/SUP-1/entries")
        .send({ kind: "note", body: "Fixed, please try again." })
    ).body as { id: number };
    const sent = await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "Fixed, please try again.", based_on: note.id });
    expect(sent.status).toBe(201);
    expect(sent.body.based_on).toBe(note.id);
  });
});
