import { parse, type HTMLElement } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// A refused form comes back with focus on the box to fix, so a keyboard or screen reader user
// lands on the message instead of the top of the page. The Title box says its limits.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "It prints",
};
const ask = { try_url: "https://example.com/try", tried: "Printed ten pages.", result: "No jam." };

/** The names of the boxes that will get focus when the page loads. */
function focused(html: HTMLElement): string[] {
  return html.querySelectorAll("[autofocus]").map((box) => box.getAttribute("name") ?? "");
}

/** The text a screen reader reads as a box's name, from its aria-labelledby. */
function nameOf(html: HTMLElement, box: HTMLElement | null): string {
  const id = box?.getAttribute("aria-labelledby") ?? "";
  return html.querySelector(`#${id}`)?.text.trim() ?? "";
}

/** The text a screen reader reads as a box's description, from its aria-describedby. */
function descriptionOf(html: HTMLElement, box: HTMLElement | null): string[] {
  const ids = box?.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => html.querySelector(`#${id}`)?.text.trim() ?? "");
}

/** SUP-1, filed by the customer and taken and started by the team member. */
async function startedTicket() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  return built;
}

describe("the ticket form after a refused submit", () => {
  it("focuses the first box with a message, in form order, and nothing else", async () => {
    const { app } = buildTestApp();
    const both = await admin(app)
      .post("/tickets")
      .type("form")
      .send({ title: "x", description: "" });
    expect(both.status).toBe(400);
    expect(focused(parse(both.text))).toEqual(["title"]);

    const second = await admin(app)
      .post("/tickets")
      .type("form")
      .send({ title: "Printer jams", description: "", where_url: "not a link" });
    expect(focused(parse(second.text))).toEqual(["description"]);

    const last = await admin(app)
      .post("/tickets")
      .type("form")
      .send({ title: "Printer jams", description: "It jams.", where_url: "not a link" });
    expect(focused(parse(last.text))).toEqual(["where_url"]);
  });

  it("focuses the box with a message on the edit form too", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const res = await admin(app)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ title: "Printer jams", description: "" });
    expect(res.status).toBe(400);
    expect(focused(parse(res.text))).toEqual(["description"]);
  });

  it("focuses nothing on a form that was not refused", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets/new").redirects(1);
    expect(focused(parse(res.text))).toEqual([]);
  });
});

describe("the Title box", () => {
  it("leaves its limits to the browser, which stops at 120 and says when it is under 3", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets/new").redirects(1);
    const html = parse(res.text);
    const title = html.querySelector("[name=title]");
    expect(nameOf(html, title)).toBe("Title");
    expect(descriptionOf(html, title)).toEqual([]);
    expect(title?.getAttribute("minlength")).toBe("3");
    expect(title?.getAttribute("maxlength")).toBe("120");
  });

  it("reads the server's message when it is refused", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/tickets")
      .type("form")
      .send({ title: "x".repeat(121), description: "It jams." });
    const html = parse(res.text);
    expect(descriptionOf(html, html.querySelector("[name=title]"))).toEqual([
      "Must be at most 120 characters.",
    ]);
  });
});

describe("the check box", () => {
  it("is named by its label words alone, so its hint is read once", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets/new").redirects(1);
    const html = parse(res.text);
    const check = html.querySelector("[name=fix_check]");
    expect(nameOf(html, check)).toBe("How will we know it's fixed? (optional)");
    expect(descriptionOf(html, check)).toHaveLength(1);
    expect(descriptionOf(html, check)[0]).toMatch(/^One thing you can check yourself/);
  });
});

describe("the ticket page's own forms after a refused submit", () => {
  it("focuses the reply box when an empty reply is refused", async () => {
    const { app } = await startedTicket();
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/entries")
      .type("form")
      .send({ kind: "reply", body: "" });
    expect(res.status).toBe(400);
    expect(focused(parse(res.text))).toEqual(["body"]);
  });

  it("focuses the box that needs words on 'No, send it back'", async () => {
    const { app } = await startedTicket();
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/change/1" });
    const ready = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask);
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/answer")
      .type("form")
      .send({ fixed: "no", ready_token: ready.body.ready_token, comment: "" });
    expect(res.status).toBe(400);
    const html = parse(res.text);
    expect(focused(html)).toEqual(["comment"]);
    expect(html.querySelector("[autofocus]")?.id).toBe("answer-comment");
  });

  it("focuses the box the resolve reason needs", async () => {
    const { app } = await startedTicket();
    const other = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "other", note: "" });
    expect(other.status).toBe(400);
    expect(focused(parse(other.text))).toEqual(["note"]);

    const duplicate = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "duplicate", duplicate_of: "" });
    expect(focused(parse(duplicate.text))).toEqual(["duplicate_of"]);
  });

  it("focuses the reason box when an empty reopen is refused", async () => {
    const { app } = await startedTicket();
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "cannot_reproduce" });
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/reopen")
      .type("form")
      .send({ reason: "" });
    expect(res.status).toBe(400);
    expect(focused(parse(res.text))).toEqual(["reason"]);
  });

  it("focuses the box with the problem when asking the customer is refused", async () => {
    const { app } = await startedTicket();
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/ready")
      .type("form")
      .send({ try_url: "not a link", tried: "Printed.", result: "" });
    expect(res.status).toBe(400);
    expect(focused(parse(res.text))).toEqual(["try_url"]);
  });
});
