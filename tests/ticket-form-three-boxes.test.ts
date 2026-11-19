import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne } from "./helpers.js";

// The new ticket form and the edit form are three boxes: Title, Description and "How will we know
// it's fixed? (optional)". The page link is no longer asked for, but a ticket that has one keeps
// it through an edit, and the API still takes it.

const valid = { title: "Printer jams", description: "It jams on page two." };

/** The names of the boxes a person can type in, in order. */
function boxesOf(html: ReturnType<typeof parse>) {
  return html
    .querySelectorAll("main form input:not([type=hidden]), main form textarea")
    .map((box) => box.getAttribute("name") ?? "(read-only)");
}

describe("the new ticket form", () => {
  it("is the heading, three boxes, File ticket and Cancel", async () => {
    const { app } = buildTestApp();
    const html = parse((await as(app, customerOne).get("/tickets/new").redirects(1)).text);
    const main = html.querySelector("main")!;
    expect(main.querySelectorAll("h1").map((h) => h.text)).toEqual(["New ticket"]);
    expect(boxesOf(html)).toEqual(["title", "description", "fix_check"]);
    expect(main.querySelector("nav")).toBeNull();
    expect(main.text).not.toContain("Page where it happened");
    expect(main.text).not.toContain("Initial status");
    expect(main.text).not.toContain("characters.");
    expect(main.querySelectorAll("button").map((b) => b.text)).toEqual(["File ticket"]);
  });
});

describe("the edit form", () => {
  it("has the same three boxes and no breadcrumb", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const html = parse((await admin(app).get("/tickets/SUP-1/edit")).text);
    expect(html.querySelector("main h1")?.text).toBe("Edit ticket");
    expect(html.querySelector("main nav")).toBeNull();
    expect(boxesOf(html)).toEqual(["title", "description", "fix_check"]);
  });

  it("keeps a page link the ticket already has when it is saved", async () => {
    const { app } = buildTestApp();
    const link = "https://example.com/printer";
    await admin(app)
      .post("/api/tickets")
      .send({ ...valid, where_url: link });
    const html = parse((await admin(app).get("/tickets/SUP-1/edit")).text);
    const hidden = html.querySelector("main form input[type=hidden][name=where_url]");
    expect(hidden?.getAttribute("value")).toBe(link);

    // The browser sends the form as it stands, hidden link included.
    const form = html.querySelector("main form")!;
    const fields: Record<string, string> = {};
    for (const input of form.querySelectorAll("input[name]")) {
      fields[input.getAttribute("name")!] = input.getAttribute("value") ?? "";
    }
    fields.title = "Printer jams on every page";
    fields.description = form.querySelector("textarea[name=description]")!.text;
    fields.fix_check = form.querySelector("textarea[name=fix_check]")!.text;
    const saved = await admin(app).post("/tickets/SUP-1/edit").type("form").send(fields);
    expect(saved.status).toBe(303);
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket.title).toBe("Printer jams on every page");
    expect(ticket.where_url).toBe(link);
  });

  it("leaves no link field on a ticket that has none", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const html = parse((await admin(app).get("/tickets/SUP-1/edit")).text);
    expect(html.querySelector("[name=where_url]")).toBeNull();
  });
});
