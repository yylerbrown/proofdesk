import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  handToAgent,
  teamActor,
  visitor,
} from "./helpers.js";

// The team can see at a glance who a ticket is handed to, and when its assistant asks for a
// review; the assistant can see that the ticket is handed to it.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

async function handed() {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const page = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
  const key = parse(page.text).querySelector("input.key")!.getAttribute("value")!;
  await handToAgent(app, "SUP-1", key);
  return { app, key };
}

const teamPage = async (app: Express) =>
  parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
const waitingCell = async (app: Express) =>
  parse((await as(app, teamActor).get("/tickets")).text).querySelectorAll(
    "table.tickets tbody tr td",
  )[4]?.text;

describe("a review request", () => {
  it("shows beside the check and in the list until the owner asks the customer", async () => {
    const { app, key } = await handed();
    await request(app)
      .post("/api/tickets/SUP-1/owner-review")
      .set("Authorization", `Bearer ${key}`)
      .send({ message: "Evidence attached." });
    expect((await teamPage(app)).querySelector(".review-requested")?.text).toBe(
      "Review requested by Helper",
    );
    expect(await waitingCell(app)).toBe("Review requested by Helper");
    const customer = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(customer.querySelector("main")!.text).not.toContain("Review requested");

    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/t", tried: "Printed.", result: "No jam." });
    expect((await teamPage(app)).querySelector(".review-requested")).toBeNull();
    expect(await waitingCell(app)).toBe("Customer");
  });
});

describe("who a ticket is handed to", () => {
  it("is on the team's page and in the history, and the assistant reads that it is handed to it", async () => {
    const { app, key } = await handed();
    const html = await teamPage(app);
    expect(html.querySelector(".agent-help")?.text).toMatch(
      /^Handed to Helper \(AI assistant\), since /,
    );
    expect(html.querySelector("details.history")?.text).toContain(
      "Handed to the AI assistant Helper",
    );
    const own = await request(app).get("/api/tickets/SUP-1").set("Authorization", `Bearer ${key}`);
    expect(own.body.agent_id).toBe("1");
    expect((await as(app, customerOne).get("/api/tickets/SUP-1")).body.agent_id).toBeNull();
    expect((await as(app, teamActor).get("/api/tickets/SUP-1")).body.agent_id).toBe("1");
  });

  it("is only ever an active hand-off, never the old agent_id column", async () => {
    const { app, db } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    // Nothing writes this column any more; a value left in it must not show as a hand-off.
    db.prepare("UPDATE tickets SET agent_id = '7' WHERE id = 1").run();
    expect((await as(app, teamActor).get("/api/tickets/SUP-1")).body.agent_id).toBeNull();
  });

  it("on the demo, is the demo's assistants for the sample made for them", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix);
    seedDemo(service);
    // The seed records the sample's key, so no test names a fixed number for it.
    const sample = service.assistantSampleKey();
    const team = parse(
      (await visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-team`).get(`/tickets/${sample}`))
        .text,
    );
    expect(team.querySelector(".agent-help")?.text).toMatch(/^Handed to demo assistants/);
    expect(team.querySelector("details.history")?.text).toContain(
      "Handed to the AI assistant demo assistants",
    );
    const page = parse((await visitor(built.app).post("/demo/connection")).text);
    const key = page.querySelector("input.key")!.getAttribute("value")!;
    const own = await request(built.app)
      .get(`/api/tickets/${sample}`)
      .set("Authorization", `Bearer ${key}`);
    expect(own.body.agent_id).toMatch(/^\d+$/);
  });
});
