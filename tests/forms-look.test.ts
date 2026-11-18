import { parse, type HTMLElement } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, buildTestApp, teamActor, as } from "./helpers.js";

// Refused forms and confirmation pages: what a person, or their screen reader, is told.

const valid = { title: "Printer jams", description: "It jams on page two." };

/** Each box marked wrong, with the text of the message it points to (null if it points nowhere). */
function invalidBoxes(html: HTMLElement): { name: string; message: string | null }[] {
  return html.querySelectorAll("[aria-invalid=true]").map((box) => {
    const id = box.getAttribute("aria-describedby");
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
  it("puts the two choices in one track of their own, apart from the legend", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const html = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const fieldset = html.querySelector("fieldset:has(input[name=kind])")!;
    expect(fieldset.querySelector("legend")?.text).toBe("Who sees it");
    const track = fieldset.querySelector(".kind-choice")!;
    expect(track.querySelectorAll("input[name=kind]").map((i) => i.getAttribute("value"))).toEqual([
      "reply",
      "note",
    ]);
    expect(track.querySelector("legend")).toBeNull();
  });
});
