import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, handToAgent, teamActor } from "./helpers.js";

// An assistant's evidence reaches the customer only when the ticket's owner chose it in a
// question to them, now or earlier. The history the customer sees holds no assistant's words
// and no connection details.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };
const ask = { try_url: "https://example.com/", tried: "Printed.", result: "No jam." };

async function issue(app: Express, scopes: string[]): Promise<string> {
  const page = await admin(app).post("/connections").type("form").send({ name: "Helper", scopes });
  return parse(page.text).querySelector("input.key")!.getAttribute("value")!;
}

async function handed() {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const key = await issue(app, ["read_tickets", "attach_evidence"]);
  await handToAgent(app, "SUP-1", key);
  const attach = async (body: object) =>
    (
      await request(app)
        .post("/api/tickets/SUP-1/evidence")
        .set("Authorization", `Bearer ${key}`)
        .send(body)
    ).body as { id: number };
  return { app, key, attach };
}

/** True when the customer's history, evidence list or ticket page holds this text. */
async function customerSees(app: Express, mark: string): Promise<boolean> {
  const paths = ["/api/tickets/SUP-1/events", "/api/tickets/SUP-1/evidence", "/tickets/SUP-1"];
  const pages = await Promise.all(paths.map((path) => as(app, customerOne).get(path)));
  return pages.some((page) => page.text.includes(mark));
}

describe("an assistant's evidence and the customer", () => {
  it("reaches the customer only when the owner chose it", async () => {
    const { app, key, attach } = await handed();
    const owner = as(app, teamActor);
    const first = await attach({ kind: "check_run", summary: "MARK-ONE", link: "https://a.test/" });
    expect(await customerSees(app, "MARK-ONE")).toBe(false);

    // Asked with no evidence chosen: the assistant's evidence stays with the team.
    await owner.put("/api/tickets/SUP-1/change-link").send({ change_url: "https://example.com/1" });
    await owner.post("/api/tickets/SUP-1/ready").send({ ...ask, evidence_ids: [] });
    expect(await customerSees(app, "MARK-ONE")).toBe(false);

    // Asked again with it chosen: the customer sees it.
    await owner.post("/api/tickets/SUP-1/withdraw-question");
    await owner.post("/api/tickets/SUP-1/ready").send({ ...ask, evidence_ids: [first.id] });
    expect(await customerSees(app, "MARK-ONE")).toBe(true);

    // After the customer's No, new evidence waits for the owner again, and the chosen one stays.
    const token = (await as(app, customerOne).get("/api/tickets/SUP-1")).body.ready_token;
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "no", comment: "still", ready_token: token });
    await handToAgent(app, "SUP-1", key);
    await attach({ kind: "note", summary: "MARK-TWO" });
    expect(await customerSees(app, "MARK-TWO")).toBe(false);
    expect(await customerSees(app, "MARK-ONE")).toBe(true);
  });

  it("leaves the team seeing every piece at once", async () => {
    const { app, attach } = await handed();
    await attach({ kind: "note", summary: "MARK-TEAM" });
    const team = (await as(app, teamActor).get("/api/tickets/SUP-1/evidence")).body;
    expect(team).toEqual([expect.objectContaining({ summary: "MARK-TEAM" })]);
  });

  it("records the evidence in history by its id, without its words", async () => {
    const { app, attach } = await handed();
    const saved = await attach({ kind: "note", summary: "MARK-WORDS" });
    const events = (await as(app, teamActor).get("/api/tickets/SUP-1/events")).body as {
      type: string;
      data: object;
    }[];
    const added = events.find((event) => event.type === "evidence_added")!;
    expect(added.data).toEqual({ kind: "note", evidence_id: saved.id });
  });
});

describe("the customer's view of the history", () => {
  it("carries no connection details, while the team's keeps them", async () => {
    const { app, attach } = await handed();
    await attach({ kind: "note", summary: "Checked it." });
    type Event = { type: string; actor_kind: string; context: object | null };
    const theirs = (await as(app, customerOne).get("/api/tickets/SUP-1/events")).body as Event[];
    const agentEvent = theirs.find((event) => event.actor_kind === "agent")!;
    expect(agentEvent.type).toBe("evidence_added");
    expect(theirs.every((event) => event.context === null)).toBe(true);
    const team = (await as(app, teamActor).get("/api/tickets/SUP-1/events")).body as Event[];
    expect(team.find((event) => event.actor_kind === "agent")!.context).toMatchObject({
      connection_name: "Helper",
    });
  });

  it("names an assistant's entry as the team's assistant on the customer's page", async () => {
    const { app, attach } = await handed();
    await attach({ kind: "note", summary: "Checked it." });
    const page = (await as(app, customerOne).get("/tickets/SUP-1")).text;
    expect(page).toContain("The team&#39;s assistant (AI agent)");
    expect(page).not.toContain("Helper");
  });
});
