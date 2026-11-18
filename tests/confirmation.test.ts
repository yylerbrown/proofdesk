import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  refusedBackToTicket,
  teamActor,
} from "./helpers.js";

const change = { change_url: "https://example.com/change/7" };
const tryIt = {
  try_url: "https://example.com/print",
  tried: "I printed ten pages.",
  result: "No jam.",
};

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
    const reason = await refusedBackToTicket(admin(app), "/tickets/SUP-1/status", {
      status: "resolved",
    });
    expect(reason).toMatch(
      /A status change does not resolve ticket SUP-1\. The customer confirms a fix/,
    );
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
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

    // A second ticket that was taken and linked but never started.
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Another one", description: "x" });
    await as(app, teamActor).post("/api/tickets/SUP-2/take");
    await as(app, teamActor).put("/api/tickets/SUP-2/change-link").send(change);
    const notInProgress = await as(app, teamActor).post("/api/tickets/SUP-2/ready").send(tryIt);
    expect(notInProgress.status).toBe(409);
    expect(notInProgress.body.error.code).toBe("not_in_progress");
  });

  it("shows the customer the question, their check and the page to try", async () => {
    const { app } = await setup();
    const ready = await askCustomer(app);
    expect(ready.body.ready_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(ready.body).toMatchObject({ try_url: tryIt.try_url, status: "in_progress" });
    expect(ready.body.ready_at).not.toBeNull();

    const page = await as(app, customerOne).get("/tickets/SUP-1");
    expect(page.text).toContain("Did this fix it?");
    expect(page.text).toContain("Ten pages, no jam"); // the agreed check comes first
    expect(page.text).toContain(`href="${tryIt.try_url}"`);
    expect(page.text).toContain('action="/tickets/SUP-1/answer"');

    const team = await as(app, teamActor).get("/tickets/SUP-1");
    expect(team.text).not.toContain('action="/tickets/SUP-1/answer"');
    expect(team.text).toContain("Waiting for the customer who filed this ticket");
  });

  it("resolves the ticket when the customer says yes", async () => {
    const { app } = await setup();
    const token = (await askCustomer(app)).body.ready_token as string;
    const res = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: token });
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
    const token = (await askCustomer(app)).body.ready_token as string;
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/answer")
      .type("form")
      .send({ fixed: "no", comment: "Page 4 still jams.", ready_token: token });
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
    const token = (await askCustomer(app)).body.ready_token as string;
    const res = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "no", ready_token: token });
    expect(res.status).toBe(400);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.ready_at).not.toBeNull();
  });

  it("takes the answer only from the person who filed it, and only while asked", async () => {
    const { app } = await setup();
    const early = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: "not-asked-yet" });
    expect(early.status).toBe(409);

    const token = (await askCustomer(app)).body.ready_token as string;
    const team = await as(app, teamActor)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: token });
    expect(team.status).toBe(403);
    // An admin may do almost anything, but not answer for the customer.
    const byAdmin = await admin(app)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: token });
    expect(byAdmin.status).toBe(403);
    const other = await as(app, customerTwo)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: token });
    expect(other.status).toBe(404);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
  });

  it("refuses to move an asked ticket back to New, and keeps the question open", async () => {
    const { app } = await setup();
    const token = (await askCustomer(app)).body.ready_token as string;
    const back = await as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: "new" });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe("cannot_return_to_new");
    expect((await admin(app).get("/api/tickets/SUP-1")).body.ready_token).toBe(token);
    const answered = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: token });
    expect(answered.status).toBe(200);
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
    // The change link is the team's working detail, shown on the team's page.
    const page = await as(app, teamActor).get("/tickets/SUP-1");
    expect(page.text).toContain('href="https://example.com/&#34;x&#34;"');
  });
});

describe("an answer belongs to the question that was asked", () => {
  async function waiting() {
    const built = await setup();
    const token = (await askCustomer(built.app)).body.ready_token as string;
    return { ...built, token };
  }
  const answer = (app: Awaited<ReturnType<typeof setup>>["app"], token: string) =>
    as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: token });

  it("refuses an old form's answer to a newer question, and writes nothing", async () => {
    const { app, token: tokenA } = await waiting();
    // Question A is withdrawn and question B asked, as after a second attempt at the fix.
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/change/8" });
    const b = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(tryIt);
    const tokenB = b.body.ready_token as string;
    expect(tokenB).not.toBe(tokenA);
    const eventsBefore = (await admin(app).get("/api/tickets/SUP-1/events")).body.length;

    const stale = await answer(app, tokenA);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("question_changed");
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({ status: "in_progress", ready_token: tokenB });
    expect((await admin(app).get("/api/tickets/SUP-1/events")).body).toHaveLength(eventsBefore);

    expect((await answer(app, tokenB)).status).toBe(200);
    // And only once.
    expect((await answer(app, tokenB)).status).toBe(409);
  });

  it.each([
    [
      "the ticket's text",
      {
        method: "put",
        address: "/api/tickets/SUP-1",
        body: { title: "Printer jams on page 4", description: "Every page." },
      },
    ],
    [
      "the agreed check",
      {
        method: "put",
        address: "/api/tickets/SUP-1/agreed-check",
        body: { agreed_check: "Twenty pages, no jam" },
      },
    ],
    [
      "the change link",
      {
        method: "put",
        address: "/api/tickets/SUP-1/change-link",
        body: { change_url: "https://example.com/change/9" },
      },
    ],
  ] as const)("withdraws the question when %s changes", async (_name, change) => {
    const { app, token } = await waiting();
    const res = await as(app, teamActor)[change.method](change.address).send(change.body);
    expect(res.status).toBe(200);
    expect(res.body.ready_at).toBeNull();
    expect((await admin(app).get("/api/tickets/SUP-1")).body.ready_at).toBeNull();
    expect((await answer(app, token)).status).toBe(409);
  });

  it("writes nothing when the team asks again while waiting", async () => {
    const { app, token } = await waiting();
    const before = (await admin(app).get("/api/tickets/SUP-1/events")).body.length;
    const again = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(tryIt);
    expect(again.status).toBe(200);
    expect(again.body.ready_token).toBe(token);
    expect((await admin(app).get("/api/tickets/SUP-1/events")).body).toHaveLength(before);
  });

  it("puts the question's token in every answer form on the page", async () => {
    const { app, token } = await waiting();
    const page = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    const forms = page.querySelectorAll("form[action$='/answer']");
    // Yes, No, and the three quick answers.
    expect(forms).toHaveLength(5);
    for (const form of forms) {
      expect(form.querySelector("input[name=ready_token]")?.getAttribute("value")).toBe(token);
    }
  });
});
