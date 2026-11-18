import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { sameText } from "../src/server/tickets/schemas.js";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// A browser sends each line break in a text box as "\r\n", and new text is stored with "\n"
// alone. Text stored before that may still hold "\r\n". Sending the same words again, from a
// form, must not count as a change against that older stored text.

const filed = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };
const ask = { try_url: "https://example.com/t", tried: "Printed ten pages.", result: "No jam." };

/** SUP-1 filed by the customer, taken and started by the team member. */
async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(filed);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  return built;
}

async function askCustomer(app: Express) {
  const asked = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask);
  expect(asked.status).toBe(200);
}

const events = async (app: Express) =>
  ((await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[]).map(
    (event) => event.type,
  );

const ticket = async (app: Express) => (await admin(app).get("/api/tickets/SUP-1")).body;

describe("sameText", () => {
  it("matches the same words whatever their line endings", () => {
    expect(sameText("One\r\nTwo", "One\nTwo")).toBe(true);
    expect(sameText("One\rTwo", "One\nTwo")).toBe(true);
    expect(sameText("One\nTwo", "One Two")).toBe(false);
    expect(sameText(null, null)).toBe(true);
    expect(sameText(null, "")).toBe(false);
  });
});

describe("saving the team's check with nothing changed, on text stored with \\r\\n", () => {
  it("records no team's check when the words are the customer's own", async () => {
    const { app, db } = await setup();
    db.prepare("UPDATE tickets SET fix_check = ? WHERE id = 1").run("Ten pages print\r\nNo jam");
    await askCustomer(app);
    const before = await events(app);
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/agreed-check")
      .type("form")
      .send({ agreed_check: "Ten pages print\r\nNo jam" });
    expect(res.status).toBe(303);
    expect(await events(app)).toEqual(before);
    const after = await ticket(app);
    expect(after.agreed_check).toBeNull();
    expect(after.ready_at).toEqual(expect.any(String));
  });

  it("keeps the team's check and the open question when the words are the team's", async () => {
    const { app, db } = await setup();
    db.prepare("UPDATE tickets SET fix_check = ?, agreed_check = ? WHERE id = 1").run(
      "Ten pages print\r\nNo jam",
      "Ten pages print\r\nand none jams",
    );
    await askCustomer(app);
    const before = await events(app);
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/agreed-check")
      .type("form")
      .send({ agreed_check: "Ten pages print\r\nand none jams" });
    expect(res.status).toBe(303);
    expect(await events(app)).toEqual(before);
    const after = await ticket(app);
    expect(after.agreed_check).toBe("Ten pages print\r\nand none jams");
    expect(after.ready_at).toEqual(expect.any(String));
  });
});

describe("asking the customer the same question again, on text stored with \\r\\n", () => {
  it("is a retry that changes nothing", async () => {
    const { app, db } = await setup();
    await askCustomer(app);
    db.prepare(
      "UPDATE tickets SET ready_tried = ?, ready_result = ?, ready_response = ? WHERE id = 1",
    ).run("Printed\r\nten pages.", "No jam\r\nat all.", "New roller\r\nfitted.");
    const token = (await ticket(app)).ready_token;
    const before = await events(app);
    // A form would show a refusal on the ticket page after its redirect, so the API is asked
    // here: a retry answers 200, a different question 409.
    const res = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({
      try_url: ask.try_url,
      tried: "Printed\r\nten pages.",
      result: "No jam\r\nat all.",
      response: "New roller\r\nfitted.",
    });
    expect(res.status).toBe(200);
    expect(await events(app)).toEqual(before);
    const after = await ticket(app);
    expect(after.ready_at).toEqual(expect.any(String));
    expect(after.ready_token).toBe(token);
  });
});
