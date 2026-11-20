import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// In a customer's own list, a ticket the team marked fixed waits on their answer, so it comes
// first in the default order, tagged "Needs your answer". The team's order does not change.

async function setup() {
  const { app } = buildTestApp();
  for (const title of ["Printer jams", "Invoice date wrong", "Login fails"]) {
    await as(app, customerOne).post("/api/tickets").send({ title, description: "x" }).expect(201);
  }
  // SUP-1 marked fixed by the team, SUP-2 resolved as Won't fix, SUP-3 open.
  await as(app, teamActor).post("/api/tickets/SUP-1/resolve").send({ reason: "fixed_no_reply" });
  await as(app, teamActor).post("/api/tickets/SUP-2/resolve").send({ reason: "wont_fix" });
  return app;
}

async function rows(
  app: Awaited<ReturnType<typeof setup>>,
  who: typeof teamActor,
  at = "/tickets",
) {
  return parse((await as(app, who).get(at)).text)
    .querySelectorAll("table.tickets tbody tr")
    .map((row) => ({
      key: row.querySelector(".ticket-key")!.text,
      tag: row.querySelector(".turn-tag")?.text ?? null,
    }));
}

describe("a customer's list", () => {
  it("starts with the ticket marked fixed, which needs their answer", async () => {
    const app = await setup();
    expect(await rows(app, customerOne)).toEqual([
      { key: "SUP-1", tag: "Needs your answer" },
      { key: "SUP-3", tag: null },
      { key: "SUP-2", tag: null },
    ]);
    const link = parse((await as(app, customerOne).get("/tickets")).text).querySelector(
      "a.turn-tag",
    );
    expect(link?.getAttribute("href")).toBe("/tickets/SUP-1#did-this-fix-it");
  });

  it("keeps the team's order: open first, then resolved", async () => {
    const app = await setup();
    expect((await rows(app, teamActor)).map((row) => row.key)).toEqual(["SUP-3", "SUP-2", "SUP-1"]);
  });

  it("goes back to the plain order once the customer confirms it", async () => {
    const app = await setup();
    await as(app, customerOne).post("/api/tickets/SUP-1/confirm").send({}).expect(200);
    expect((await rows(app, customerOne)).map((row) => row.key)).toEqual([
      "SUP-3",
      "SUP-2",
      "SUP-1",
    ]);
  });
});
