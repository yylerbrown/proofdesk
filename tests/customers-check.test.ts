import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The check is the customer's own words. The team may offer an interpretation beside them,
// which the customer may adopt; only then are those words the check.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};
const reread = async (app: Express) => (await admin(app).get("/api/tickets/SUP-1")).body;

describe("the team and the customer's words", () => {
  it("lets the team edit the title, never the check", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const res = await as(app, teamActor)
      .put("/api/tickets/SUP-1")
      .send({ ...valid, title: "Printer jams on page two", fix_check: "Anything" });
    expect(res.status).toBe(200);
    expect(await reread(app)).toMatchObject({
      title: "Printer jams on page two",
      fix_check: "Ten pages print",
    });
    const form = parse((await as(app, teamActor).get("/tickets/SUP-1/edit")).text);
    expect(form.querySelector("textarea[name=fix_check]")).toBeNull();
    expect(form.querySelector("#fix_check-locked")?.text).toMatch(/Only they can change them/);
    const own = parse((await as(app, customerOne).get("/tickets/SUP-1/edit")).text);
    expect(own.querySelector("textarea[name=fix_check]")?.text).toBe("Ten pages print");
  });

  it("labels the team's wording as its interpretation, never as agreed", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: "A 10-page PDF prints twice" });
    const page = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      "main",
    )!.text;
    expect(page).toContain("Team's interpretation");
    expect(page).not.toContain("Agreed check");
    expect((await reread(app)).done_when).toMatchObject({
      team_interpretation: "A 10-page PDF prints twice",
      customer_check: "Ten pages print",
    });
  });
});

describe("the customer's own changes", () => {
  it("retire the team's interpretation, withdraw an open question, and keep the old words in the history", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: "A 10-page PDF prints twice" });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/t", tried: "Printed.", result: "Fine." });
    await as(app, customerOne)
      .put("/api/tickets/SUP-1")
      .send({ ...valid, fix_check: "Twenty pages print" });
    expect(await reread(app)).toMatchObject({
      fix_check: "Twenty pages print",
      agreed_check: null,
      ready_at: null,
    });
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as {
      type: string;
      data: Record<string, unknown>;
    }[];
    const edited = events.find((e) => e.type === "edited");
    expect(edited?.data).toMatchObject({
      changes: { fix_check: { from: "Ten pages print", to: "Twenty pages print" } },
    });
  });

  it("can adopt the team's interpretation as their own check; nobody else can", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: "A 10-page PDF prints twice" });
    // The owner has already asked, against the old words.
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/t", tried: "Printed.", result: "Fine." });
    expect((await as(app, teamActor).post("/api/tickets/SUP-1/adopt-check")).status).toBe(403);
    const page = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(page.querySelector("form[action$='/adopt-check'] button")?.text).toBe(
      "Use these words as my check",
    );
    const adopted = await as(app, customerOne).post("/tickets/SUP-1/adopt-check");
    expect(adopted.status).toBe(303);
    expect(await reread(app)).toMatchObject({
      fix_check: "A 10-page PDF prints twice",
      agreed_check: null,
      ready_at: null,
    });
    const last = (await admin(app).get("/api/tickets/SUP-1/events")).body.at(-1);
    expect(last).toMatchObject({
      type: "check_adopted",
      data: { from: "Ten pages print", to: "A 10-page PDF prints twice" },
    });
  });
});

describe("a ticket with no check", () => {
  it("can be filed, but not sent to the customer for confirmation", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    const res = await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/t", tried: "Printed.", result: "Fine." });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("needs_check");
    // A team interpretation alone is not enough: the customer has not said it.
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: "Ten pages print" });
    const still = await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/t", tried: "Printed.", result: "Fine." });
    expect(still.body.error.code).toBe("needs_check");
  });
});
