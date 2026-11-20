import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { forbidden, READ_ONLY_REFUSAL } from "../src/server/errors.js";
import { CAPABILITIES, type Action } from "../src/server/permissions.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// A refusal says who may do the action, in the words of the table the page Who may do what
// shows, and points to that page. The demo's read-only admin keeps its own refusal.

const filed = {
  title: "The export button downloads an empty file",
  description: "Every export since Monday is empty.",
  fix_check: "An export of last week has rows in it.",
};

describe("a refusal that says who may", () => {
  it("names who may from the table, for every action", () => {
    for (const action of Object.keys(CAPABILITIES) as Action[]) {
      const refusal = forbidden({}, action);
      expect(refusal.status).toBe(403);
      expect(refusal.message).toBe(
        `You are not allowed to do that. Who may: ${CAPABILITIES[action].people} See who may do what at /roles.`,
      );
    }
  });

  it("keeps the read-only preview's own words", () => {
    expect(forbidden({ readOnly: true }, "delete").message).toBe(READ_ONLY_REFUSAL);
  });

  it("tells a customer in the API who may write an internal note", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    const res = await as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "note", body: "Hello" });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(
      "You are not allowed to do that. Who may: The team. See who may do what at /roles.",
    );
  });

  it("links to Who may do what on the page that refuses a delete", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    const res = await as(app, teamActor).get("/tickets/SUP-1/delete");
    expect(res.status).toBe(403);
    const main = parse(res.text).querySelector("main")!;
    expect(main.text).toContain("You are not allowed to do that. Who may: An admin.");
    expect(main.text).not.toContain("/roles.");
    const link = main.querySelectorAll("a").find((a) => a.getAttribute("href") === "/roles");
    expect(link?.text).toBe("who may do what");
  });

  it("tells a team member on People what their role is", async () => {
    const { app } = buildTestApp();
    const res = await as(app, teamActor).get("/people");
    expect(res.status).toBe(403);
    expect(parse(res.text).querySelector("main")!.text).toContain(
      "Only an admin chooses who is on the team. You are a team member.",
    );
  });
});
