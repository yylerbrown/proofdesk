import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { wireQuickAnswers, type Field, type QuickButton } from "../src/browser/quick.js";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Quick answers are plain words on ordinary buttons. Without scripts each sends its words as an
// ordinary answer or reply; with the script, it fills the box to change before sending.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

async function asked() {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  await as(app, teamActor)
    .put("/api/tickets/SUP-1/change-link")
    .send({ change_url: "https://example.com/c" });
  await as(app, teamActor)
    .post("/api/tickets/SUP-1/ready")
    .send({ try_url: "https://example.com/t", tried: "Printed.", result: "No jam." });
  return app;
}

/** Each quick button on a page: its words, what it fills, and the form it would send. */
const quick = async (app: Express, who: typeof teamActor) =>
  parse((await as(app, who).get("/tickets/SUP-1")).text)
    // The quick answers fill a box; the status row's buttons share their look, not their job.
    .querySelectorAll("button.quick[data-fill]")
    .map((button) => ({
      words: button.text,
      sends: [button.getAttribute("name"), button.getAttribute("value")],
      fills: button.getAttribute("data-fill"),
      action: button.parentNode!.getAttribute("action"),
    }));

describe("the quick-answer script", () => {
  it("fills the named box with the button's words and keeps the form from sending", () => {
    const field: Field = { value: "", focus: () => undefined };
    let click: (event: { preventDefault(): void }) => void = () => {};
    const button: QuickButton = {
      dataset: { fill: "entry-body", fillKind: "reply" },
      value: "Can you send a screenshot?",
      addEventListener: (_type, listener) => (click = listener),
    };
    const kinds: string[] = [];
    wireQuickAnswers(
      [button],
      (id) => (id === "entry-body" ? field : null),
      (k) => kinds.push(k),
    );
    let prevented = false;
    click({ preventDefault: () => (prevented = true) });
    expect(field.value).toBe("Can you send a screenshot?");
    expect(prevented).toBe(true);
    expect(kinds).toEqual(["reply"]);
  });

  it("lets the button send its words as they are when the box is not there", () => {
    let click: (event: { preventDefault(): void }) => void = () => {};
    const button: QuickButton = {
      dataset: { fill: "missing" },
      value: "Partly fixed",
      addEventListener: (_type, listener) => (click = listener),
    };
    wireQuickAnswers([button], () => null);
    let prevented = false;
    click({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(false);
  });
});

describe("quick answers on No", () => {
  it("are offered to the customer being asked, each filling the comment box", async () => {
    const app = await asked();
    const found = await quick(app, customerOne);
    expect(found.map((q) => q.words)).toEqual([
      "Still happening",
      "Partly fixed",
      "Something else broke",
    ]);
    for (const q of found) {
      expect(q.sends).toEqual(["comment", q.words]);
      expect(q.fills).toBe("answer-comment");
      expect(q.action).toBe("/tickets/SUP-1/answer");
    }
    const page = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(page.querySelector("textarea#answer-comment")).not.toBeNull();
  });

  it("send their words as an ordinary No when pressed with scripts off", async () => {
    const app = await asked();
    const token = (await as(app, customerOne).get("/api/tickets/SUP-1")).body.ready_token;
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/answer")
      .type("form")
      .send({ fixed: "no", ready_token: token, comment: "Partly fixed" });
    expect(res.status).toBe(303);
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket.customer_answer).toMatchObject({ fixed: false, comment: "Partly fixed" });
  });
});

describe("quick replies for the team", () => {
  it("are offered to the team only, each filling the message box as a reply", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const found = await quick(app, teamActor);
    expect(found.map((q) => q.words)).toEqual([
      "Thanks, we can reproduce this.",
      "Can you send a screenshot?",
      "Which browser and device are you using?",
    ]);
    for (const q of found) {
      expect(q.sends).toEqual(["body", q.words]);
      expect(q.fills).toBe("entry-body");
    }
    expect(await quick(app, customerOne)).toEqual([]);
  });

  it("land as an ordinary reply the customer sees", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/entries")
      .type("form")
      .send({ kind: "reply", body: "Can you send a screenshot?" });
    expect(res.status).toBe(303);
    const seen = (await as(app, customerOne).get("/api/tickets/SUP-1/entries")).body;
    expect(seen.at(-1)).toMatchObject({ kind: "reply", body: "Can you send a screenshot?" });
  });
});
