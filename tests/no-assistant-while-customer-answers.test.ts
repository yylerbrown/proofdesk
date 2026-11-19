import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Asking the customer ends any assistant's work, so while the customer is answering, the ticket
// cannot be handed to an assistant, and no assistant can withdraw their question by the way.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

async function asked() {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  const owner = as(app, teamActor);
  await owner.post("/api/tickets/SUP-1/take-and-start");
  await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "link_changes"] });
  await owner.put("/api/tickets/SUP-1/change-link").send({ change_url: "https://example.com/1" });
  const ready = await owner.post("/api/tickets/SUP-1/ready").send({});
  return { app, owner, token: ready.body.ready_token as string };
}

describe("handing a ticket to an assistant while the customer is answering", () => {
  it("is refused, and the customer's question stays open", async () => {
    const { app, owner, token } = await asked();
    const res = await owner.post("/api/tickets/SUP-1/agent").send({ connection_id: 1 });
    expect([res.status, res.body.error?.code]).toEqual([409, "question_open"]);
    const ticket = (await as(app, customerOne).get("/api/tickets/SUP-1")).body;
    expect([ticket.waiting_on, ticket.ready_token]).toEqual(["customer", token]);
  });

  it("is not offered on the owner's page", async () => {
    const { app } = await asked();
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(page.querySelector('form[action="/tickets/SUP-1/agent"]')).toBeNull();
  });

  it("works again once the owner withdraws the question", async () => {
    const { owner } = await asked();
    await owner.post("/api/tickets/SUP-1/withdraw-question");
    const res = await owner.post("/api/tickets/SUP-1/agent").send({ connection_id: 1 });
    expect(res.status).toBe(200);
  });
});
