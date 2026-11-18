import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

const change = { change_url: "https://example.com/change/7" };
const tryIt = { try_url: "https://example.com/print" };

/** Customer one's SUP-1, taken by the team, in progress, with an agreed check. */
async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "Every page.", fix_check: "It prints" });
  const team = as(built.app, teamActor);
  await team.post("/api/tickets/SUP-1/take");
  await team.patch("/api/tickets/SUP-1").send({ status: "in_progress" });
  await team.put("/api/tickets/SUP-1/agreed-check").send({ agreed_check: "Ten pages, no jam" });
  return built;
}

/** Adds the change link and asks the customer. */
async function askCustomer(app: Awaited<ReturnType<typeof setup>>["app"]) {
  await as(app, teamActor).put("/api/tickets/SUP-1/change-link").send(change);
  return as(app, teamActor).post("/api/tickets/SUP-1/ready").send(tryIt);
}

describe("only the customer resolves a ticket", () => {
  it("refuses Resolved from the status control, on the API and on the page", async () => {
    const { app } = await setup();
    const api = await admin(app).patch("/api/tickets/SUP-1").send({ status: "resolved" });
    expect(api.status).toBe(409);
    expect(api.body.error.code).toBe("needs_customer");
    const form = await admin(app)
      .post("/tickets/SUP-1/status")
      .type("form")
      .send({ status: "resolved" });
    expect(form.status).toBe(409);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");

    const page = await admin(app).get("/tickets/SUP-1");
    expect(page.text).not.toContain('<option value="resolved"');
  });
});

describe("from merged to confirmed", () => {
  it("records the change link as evidence, with its history entry", async () => {
    const { app } = await setup();
    const res = await as(app, teamActor).put("/api/tickets/SUP-1/change-link").send(change);
    expect(res.body.change_url).toBe(change.change_url);
    expect(res.body.status).toBe("in_progress"); // a link is not proof
    const last = (await admin(app).get("/api/tickets/SUP-1/events")).body.at(-1);
    expect(last).toMatchObject({
      type: "change_linked",
      data: { from: null, to: change.change_url },
    });
  });

  it("asks the customer only once the ticket is in progress and has its change link", async () => {
    const { app } = await setup();
    const noLink = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(tryIt);
    expect(noLink.status).toBe(409);
    expect(noLink.body.error.code).toBe("needs_change_link");

    await as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: "new" });
    await as(app, teamActor).put("/api/tickets/SUP-1/change-link").send(change);
    const notInProgress = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(tryIt);
    expect(notInProgress.status).toBe(409);
    expect(notInProgress.body.error.code).toBe("not_in_progress");
  });

  it("shows the customer the question, their check and the page to try", async () => {
    const { app } = await setup();
    const ready = await askCustomer(app);
    expect(ready.body).toMatchObject({ try_url: tryIt.try_url, status: "in_progress" });
    expect(ready.body.ready_at).not.toBeNull();

    const page = await as(app, customerOne).get("/tickets/SUP-1");
    expect(page.text).toContain("Did this fix it?");
    expect(page.text).toContain("Ten pages, no jam"); // the agreed check comes first
    expect(page.text).toContain(`href="${tryIt.try_url}"`);
    expect(page.text).toContain('action="/tickets/SUP-1/answer"');

    const team = await as(app, teamActor).get("/tickets/SUP-1");
    expect(team.text).not.toContain('action="/tickets/SUP-1/answer"');
    expect(team.text).toContain("Waiting for the customer to check it");
  });

  it("resolves the ticket when the customer says yes", async () => {
    const { app } = await setup();
    await askCustomer(app);
    const res = await as(app, customerOne).post("/api/tickets/SUP-1/answer").send({ fixed: "yes" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "resolved", ready_at: null });
    const last = (await admin(app).get("/api/tickets/SUP-1/events")).body.at(-1);
    expect(last).toMatchObject({
      type: "customer_answered",
      actor: customerOne.id,
      data: { fixed: true },
    });
  });

  it("sends it back to its owner with the customer's comment when they say no", async () => {
    const { app } = await setup();
    await askCustomer(app);
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/answer")
      .type("form")
      .send({ fixed: "no", comment: "Page 4 still jams." });
    expect(res.status).toBe(303);

    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({
      status: "in_progress",
      ready_at: null,
      owner_name: "Team Member",
    });
    const entries = (await admin(app).get("/api/tickets/SUP-1/entries")).body;
    expect(entries.at(-1)).toMatchObject({
      kind: "reply",
      author: customerOne.id,
      body: "Page 4 still jams.",
    });
    const page = await as(app, teamActor).get("/tickets/SUP-1");
    expect(page.text).toContain("Customer says it is not fixed");
  });

  it("needs a comment for a no", async () => {
    const { app } = await setup();
    await askCustomer(app);
    const res = await as(app, customerOne).post("/api/tickets/SUP-1/answer").send({ fixed: "no" });
    expect(res.status).toBe(400);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.ready_at).not.toBeNull();
  });

  it("takes the answer only from the person who filed it, and only while asked", async () => {
    const { app } = await setup();
    const early = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes" });
    expect(early.status).toBe(409);

    await askCustomer(app);
    const team = await as(app, teamActor).post("/api/tickets/SUP-1/answer").send({ fixed: "yes" });
    expect(team.status).toBe(403);
    const other = await as(app, customerTwo)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes" });
    expect(other.status).toBe(404);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
  });

  it("withdraws the question when the team changes the status", async () => {
    const { app } = await setup();
    await askCustomer(app);
    await as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: "new" });
    expect((await admin(app).get("/api/tickets/SUP-1")).body.ready_at).toBeNull();
    const late = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes" });
    expect(late.status).toBe(409);
  });

  it("is the team's to start: a customer cannot add the link or ask themselves", async () => {
    const { app } = await setup();
    const one = as(app, customerOne);
    expect((await one.put("/api/tickets/SUP-1/change-link").send(change)).status).toBe(403);
    expect((await one.post("/api/tickets/SUP-1/ready").send(tryIt)).status).toBe(403);
  });

  it("accepts only http and https links, and shows a quote in a link as text", async () => {
    const { app } = await setup();
    const team = as(app, teamActor);
    const bad = await team
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
    await team
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: 'https://example.com/"x"' });
    const page = await as(app, customerOne).get("/tickets/SUP-1");
    expect(page.text).toContain('href="https://example.com/&#34;x&#34;"');
  });
});
