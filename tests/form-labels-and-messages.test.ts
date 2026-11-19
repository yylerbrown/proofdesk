import { parse, type HTMLElement } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Refused forms and confirmation pages: what a person, or their screen reader, is told.

const valid = { title: "Printer jams", description: "It jams on page two." };

/** Each box marked wrong, with the text of the message it points to (null if it points nowhere). */
function invalidBoxes(html: HTMLElement): { name: string; message: string | null }[] {
  return html.querySelectorAll("[aria-invalid=true]").map((box) => {
    // The message comes first; a hint, such as the title's limits, may follow it.
    const id = box.getAttribute("aria-describedby")?.split(" ")[0];
    const message = id ? (html.querySelector(`#${id}`)?.text.trim() ?? null) : null;
    return { name: box.getAttribute("name") ?? "", message };
  });
}

describe("a refused form", () => {
  it("ties each message on the new ticket form to its box", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/tickets")
      .type("form")
      .send({ title: "x", description: "" });
    expect(res.status).toBe(400);
    const boxes = invalidBoxes(parse(res.text));
    expect(boxes.map((box) => box.name)).toEqual(["title", "description"]);
    for (const box of boxes) expect(box.message).toMatch(/^Must /);
  });

  it("ties the message to the box on the ticket page and on the delete page", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const reply = await as(app, teamActor)
      .post("/tickets/SUP-1/entries")
      .type("form")
      .send({ body: "" });
    expect(reply.status).toBe(400);
    expect(invalidBoxes(parse(reply.text))).toEqual([
      { name: "body", message: expect.stringMatching(/\S/) },
    ]);
    const wrong = await admin(app)
      .post("/tickets/SUP-1/delete")
      .type("form")
      .send({ confirm: "no" });
    expect(wrong.status).toBe(400);
    expect(invalidBoxes(parse(wrong.text))).toEqual([
      { name: "confirm", message: expect.stringMatching(/\S/) },
    ]);
  });
});

describe("confirmation pages", () => {
  it.each([
    ["/tickets/SUP-1/archive", "Archive ticket"],
    ["/tickets/SUP-1/delete", "Delete permanently"],
  ])("%s offers Keep first and the destructive button in red", async (address, label) => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const html = parse((await admin(app).get(address)).text);
    const choice = html.querySelectorAll(".choice > *");
    expect(choice.map((item) => item.text.trim())).toEqual(["Keep ticket", label]);
    expect(choice[1]?.classList.contains("danger")).toBe(true);
    expect(choice[0]?.classList.contains("danger")).toBe(false);
  });
});

describe("who sees a message", () => {
  it("is two tabs on top of a three-line box, with the labels kept for screen readers", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const html = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const form = html.querySelector("form.reply-box")!;
    const tabs = form.querySelector("fieldset.kind-tabs")!;
    expect(tabs.querySelector("legend")?.text).toBe("Who sees it");
    expect(tabs.querySelector("legend")?.classList.contains("visually-hidden")).toBe(true);
    expect(tabs.querySelectorAll("label").map((label) => label.text.trim())).toEqual([
      "Reply to the customer",
      "Internal note",
    ]);
    const label = form.querySelector("label[for=entry-body]")!;
    expect(label.text).toBe("Your message");
    expect(label.classList.contains("visually-hidden")).toBe(true);
    expect(form.querySelector("textarea#entry-body")?.getAttribute("rows")).toBe("3");
    // The canned replies are gone from the team's reply box.
    expect(html.querySelectorAll("button[data-fill]")).toHaveLength(0);
  });

  it("gives the customer, who has no tabs, the box's label for screen readers only", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    const form = html.querySelector("form.reply-box")!;
    expect(form.querySelector("fieldset.kind-tabs")).toBeNull();
    // The line they pressed to open the box already says "Write a message".
    expect(html.querySelector("details.reply-fold > summary")?.text).toBe("Write a message");
    const label = form.querySelector("label[for=entry-body]")!;
    expect(label.text).toBe("Your message");
    expect(label.classList.contains("visually-hidden")).toBe(true);
  });
});
