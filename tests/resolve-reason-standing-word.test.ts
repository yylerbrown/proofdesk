import fs from "node:fs";
import type { Express } from "express";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { READ_ONLY_REFUSAL } from "../src/server/errors.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// "Fixed, but the customer has not replied" follows the customer's standing word, the same one
// the card's line at the top links to. The resolve form's note box shows only for Other, and a note
// left in it after choosing another reason is not sent. A few smaller refusals say the right
// thing.

const filed = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };
const ask = { try_url: "https://example.com/t", tried: "Printed.", result: "No jam." };

/** SUP-1 filed by the customer, and taken and started by the team member. */
async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(filed);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  return built;
}

/** The team asks the customer whether it is fixed, and returns the question's token. */
async function askCustomer(app: Express): Promise<string> {
  const asked = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask);
  expect(asked.status).toBe(200);
  return asked.body.ready_token as string;
}

async function answer(app: Express, fixed: "yes" | "no", comment?: string) {
  const token = await askCustomer(app);
  const res = await as(app, customerOne)
    .post("/api/tickets/SUP-1/answer")
    .send({ fixed, comment, ready_token: token });
  expect(res.status).toBe(200);
}

const reasonsOffered = async (app: Express) =>
  parse((await as(app, teamActor).get("/tickets/SUP-1?step=resolve")).text)
    .querySelectorAll('form.resolve input[name="reason"]')
    .map((radio) => radio.getAttribute("value"));

const resolveNoReply = (app: Express) =>
  as(app, teamActor).post("/api/tickets/SUP-1/resolve").send({ reason: "fixed_no_reply" });

describe("'Fixed, but the customer has not replied'", () => {
  it("comes back once the team asks again after a No and the customer stays silent", async () => {
    const { app } = await setup();
    await answer(app, "no", "Still jams on page two.");
    expect(await reasonsOffered(app)).not.toContain("fixed_no_reply");
    await askCustomer(app);
    expect(await reasonsOffered(app)).toContain("fixed_no_reply");
    const res = await resolveNoReply(app);
    expect([res.status, res.body.resolution?.reason]).toEqual([200, "fixed_no_reply"]);
  });

  it("is not offered, and is refused, after the customer reopens", async () => {
    const { app } = await setup();
    await answer(app, "yes");
    const reopened = await as(app, customerOne)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "Broke again after the update." });
    expect(reopened.status).toBe(200);
    expect(await reasonsOffered(app)).not.toContain("fixed_no_reply");
    const res = await resolveNoReply(app);
    expect(res.status).toBe(400);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
  });
});

describe("the resolve form's note box", () => {
  it("shows only for Other, the one reason that needs it", () => {
    const css = fs.readFileSync(new URL("../public/site.css", import.meta.url), "utf8");
    expect(css).toContain('form.resolve:not(:has(input[value="other"]:checked)) .resolve-note');
  });

  it("sends no hidden words: a note left behind with another reason is dropped", async () => {
    const { app } = await setup();
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "wont_fix", note: "Typed under Other, then changed my mind." });
    expect(res.status).toBe(303);
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket.resolution).toMatchObject({ reason: "wont_fix", note: null });
  });

  it("keeps the note for Other, which needs it", async () => {
    const { app } = await setup();
    await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "other", note: "Handled by phone." });
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket.resolution).toMatchObject({ reason: "other", note: "Handled by phone." });
  });
});

describe("releasing a ticket nobody owns", () => {
  it("answers with a hint that fits", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    const res = await as(app, teamActor).post("/api/tickets/SUP-1/release");
    expect([res.status, res.body.error.code]).toEqual([409, "no_owner"]);
    expect(res.body.error.hint).toContain("Nobody owns this ticket");
  });
});

describe("saving an edit of text stored with old line endings", () => {
  it("records no change when the words and line breaks are the same", async () => {
    const { app, db } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    db.prepare("UPDATE tickets SET description = ? WHERE id = 1").run("Line one\r\nLine two");
    const res = await as(app, customerOne)
      .put("/api/tickets/SUP-1")
      .send({ ...filed, description: "Line one\r\nLine two" });
    expect(res.status).toBe(200);
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
    expect(events.map((event) => event.type)).not.toContain("edited");
  });

  it("keeps the team's agreed check and the open question when the team saves the same text", async () => {
    const { app, db } = await setup();
    db.prepare("UPDATE tickets SET fix_check = ? WHERE id = 1").run("Ten pages print\r\nNo jam");
    const agreed = await as(app, teamActor)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: "Ten pages print and none jams" });
    expect(agreed.status).toBe(200);
    await askCustomer(app);
    const eventCount = async () =>
      ((await admin(app).get("/api/tickets/SUP-1/events")).body as unknown[]).length;
    const countBefore = await eventCount();
    for (let save = 0; save < 2; save++) {
      const res = await as(app, teamActor)
        .put("/api/tickets/SUP-1")
        .send({ title: filed.title, description: filed.description });
      expect(res.status).toBe(200);
    }
    expect(await eventCount()).toBe(countBefore);
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket.agreed_check).toBe("Ten pages print and none jams");
    expect(ticket.ready_at).toEqual(expect.any(String));
  });
});

describe("the read-only admin preview on a confirmation page", () => {
  it("is told the preview is read-only, once", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    for (const page of ["archive", "delete"]) {
      const res = await visitor(built.app)
        .get(`/tickets/SUP-1/${page}`)
        .set("Cookie", `${DEV_COOKIE}=demo-admin`);
      expect(res.status).toBe(403);
      const main = parse(res.text).querySelector("main")!.text;
      expect(main).toContain(READ_ONLY_REFUSAL);
      expect(main).not.toContain("You are not allowed to do that.");
      expect(main.split("The admin preview is read-only.")).toHaveLength(2);
    }
  });
});
