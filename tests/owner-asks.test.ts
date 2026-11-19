import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { AGENT_SCOPES } from "../src/server/permissions.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  handToAgent,
  refusedBackToTicket,
  teamActor,
} from "./helpers.js";

// Only the ticket's current owner asks the customer, on a ticket in progress. What they tried,
// what happened, a page to try, what changed since a No and evidence are all optional, and the
// customer sees each one given.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};
const ask = {
  try_url: "https://example.com/print",
  tried: "Printed ten pages.",
  result: "No jam.",
};

/** A ticket filed by the customer, owned and started by the team member, with its change link. */
async function ready(app: Express) {
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  await as(app, teamActor)
    .put("/api/tickets/SUP-1/change-link")
    .send({ change_url: "https://example.com/c/1" });
}

const reread = async (app: Express) => (await admin(app).get("/api/tickets/SUP-1")).body;

describe("who asks the customer", () => {
  it("only the current owner: not another team member, not an agent, not a former owner", async () => {
    const { app } = buildTestApp();
    await ready(app);
    const other = await admin(app).post("/api/tickets/SUP-1/ready").send(ask);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("not_owner");

    const res = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: [...AGENT_SCOPES] });
    const key = parse(res.text).querySelector("input.key")!.getAttribute("value")!;
    await handToAgent(app, "SUP-1", key);
    const agent = await request(app)
      .post("/api/tickets/SUP-1/ready")
      .set("Authorization", `Bearer ${key}`)
      .send(ask);
    expect(agent.status).toBe(403);

    // An admin hands the ticket to themselves; the former owner's old form is refused.
    await admin(app)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-admin-1", expected_owner: "dev-team-1" });
    const reason = await refusedBackToTicket(as(app, teamActor), "/tickets/SUP-1/ready", ask);
    expect(reason).toMatch(/Only Admin, who owns ticket SUP-1, can ask the customer to verify/);
    expect((await reread(app)).ready_at).toBeNull();

    const owner = await admin(app).post("/api/tickets/SUP-1/ready").send(ask);
    expect(owner.status).toBe(200);
  });

  it("may leave every box empty, and a link that is not one comes back with what was typed", async () => {
    const { app } = buildTestApp();
    await ready(app);
    const page = await as(app, teamActor)
      .post("/tickets/SUP-1/ready")
      .type("form")
      .send({ try_url: "not a link", tried: "Printed it", result: "" });
    expect(page.status).toBe(400);
    const form = parse(page.text).querySelector("form.ask");
    expect(form?.querySelector("textarea[name=tried]")?.text).toBe("Printed it");
    expect(parse(page.text).querySelector("#ready-error")?.text).toMatch(/http or https/);
    // The form's empty boxes are not given: the customer is asked with nothing else.
    const empty = await as(app, teamActor)
      .post("/tickets/SUP-1/ready")
      .type("form")
      .send({ try_url: "", tried: "", result: "" });
    expect(empty.status).toBe(303);
    expect((await reread(app)).ask).toMatchObject({ try_url: null, tried: null, result: null });
  });

  it("shows the customer what the owner tried and what happened", async () => {
    const { app } = buildTestApp();
    await ready(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask);
    expect((await reread(app)).ask).toMatchObject({
      tried: ask.tried,
      result: ask.result,
      response_to_no: null,
    });
    const box = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      "#did-this-fix-it",
    );
    expect(box?.text).toContain("Team Member tried:");
    expect(box?.text).toContain("Printed ten pages.");
    expect(box?.text).toContain("No jam.");
  });

  it("only relies on evidence attached to this ticket", async () => {
    const { app } = buildTestApp();
    await ready(app);
    const wrong = await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ ...ask, evidence_ids: [999] });
    expect(wrong.status).toBe(400);
    const evidence = (
      await as(app, teamActor)
        .post("/api/tickets/SUP-1/evidence")
        .send({ kind: "check_run", summary: "Printed twice" })
    ).body;
    const right = await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ ...ask, evidence_ids: [evidence.id] });
    expect(right.status).toBe(200);
    expect((await reread(app)).ask.evidence_ids).toEqual([evidence.id]);
  });
});

describe("after a No", () => {
  it("asks again in one press, and shows what changed when the owner says it", async () => {
    const { app } = buildTestApp();
    await ready(app);
    const say = async (comment: string) => {
      const { ready_token } = await reread(app);
      await as(app, customerOne)
        .post("/api/tickets/SUP-1/answer")
        .send({ fixed: "no", comment, ready_token });
    };
    await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask);
    await say("Still jams double-sided.");

    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    // The page to try is filled in from the last question, and what changed is optional.
    expect(page.querySelector("form.ask input[name=try_url]")?.getAttribute("value")).toBe(
      ask.try_url,
    );
    const response = page.querySelector("form.ask textarea[name=response]")!;
    expect(response.hasAttribute("required")).toBe(false);

    const bare = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({});
    expect(bare.status).toBe(200);
    const plain = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(plain.querySelector("#did-this-fix-it")?.text).not.toContain("What changed");
    await say("Still jams.");

    const again = await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ ...ask, response: "Fixed double-sided printing." });
    expect(again.status).toBe(200);
    const box = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      "#did-this-fix-it",
    );
    expect(box?.text).toContain("What changed since you said it still fails:");
    expect(box?.text).toContain("Fixed double-sided printing.");
  });
});

describe("the ask on the ticket page", () => {
  it("is offered to the owner only, and never shown greyed to anyone else", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    // The owner asks without a change link: the form, never a greyed button.
    const noLink = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(noLink.querySelector("form.ask")).not.toBeNull();
    expect(noLink.querySelector(".ask-blocked")).toBeNull();
    // Anyone else sees no ask at all: a control that cannot be pressed is not shown.
    const notMine = parse((await admin(app).get("/tickets/SUP-1")).text);
    expect(notMine.querySelector("form.ask")).toBeNull();
    expect(notMine.querySelector(".ask-blocked")).toBeNull();
    expect(notMine.querySelector("main")!.text).not.toContain("Ask the customer to verify");
    expect(
      parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(".ask-blocked"),
    ).toBeNull();
  });

  it("is possible when the customer has not said how they will know", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ ...valid, fix_check: undefined });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(page.querySelector("form.ask")).not.toBeNull();
    expect(page.querySelector(".ask-blocked")).toBeNull();
    // The server accepts it too, so the page offers nothing that would fail.
    const res = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask);
    expect(res.status).toBe(200);
  });
});
