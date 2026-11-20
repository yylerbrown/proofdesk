import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import {
  countWords,
  wireCount,
  type CountedBox,
  type CountLine,
} from "../src/browser/char-count.js";
import { DESCRIPTION_LIMIT } from "../src/server/pages/text-limit.js";
import { as, buildTestApp, customerOne } from "./helpers.js";

// A long pasted description is never cut off without a word. The box has no maxlength, so the
// browser keeps the whole paste; its limit is written under it, a count shows as the text nears
// it, and the refused form keeps the text and says how far over it was.

const valid = { title: "Printer jams", description: "It jams on page two." };

describe("the description box", () => {
  it("leaves the length to the server, not the browser, and counts near the limit", async () => {
    const { app } = buildTestApp();
    const page = parse((await as(app, customerOne).get("/tickets/new").redirects(1)).text);
    const box = page.querySelector("textarea[name=description]")!;
    expect(box.hasAttribute("maxlength")).toBe(false);
    expect(box.getAttribute("data-count-limit")).toBe("5000");
    // One standing hint says what the description is for. The count shows near the limit, and a
    // refused form says what is wrong.
    expect(page.querySelector("#description-hint")?.text).toBe(
      "The context: what you were doing, and what happened.",
    );
    expect(box.getAttribute("aria-describedby")).toBe("description-hint description-count");
  });

  it("has the same limit as the service", async () => {
    const { app } = buildTestApp();
    const at = (length: number) =>
      as(app, customerOne)
        .post("/api/tickets")
        .send({ ...valid, description: "a".repeat(length) });
    expect((await at(DESCRIPTION_LIMIT)).status).toBe(201);
    expect((await at(DESCRIPTION_LIMIT + 1)).status).toBe(400);
  });
});

describe("a description over the limit", () => {
  it("is refused with how far over it was, and kept in full", async () => {
    const { app } = buildTestApp();
    const long = "a".repeat(5200);
    const res = await as(app, customerOne)
      .post("/tickets")
      .type("form")
      .send({ ...valid, description: long });
    expect(res.status).toBe(400);
    const page = parse(res.text);
    expect(page.querySelector("#description-error")?.text).toBe(
      "Must be at most 5000 characters. It is 200 characters over.",
    );
    expect(page.querySelector("textarea[name=description]")?.text).toBe(long);
  });

  it("is refused the same way on the edit form", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ ...valid, description: "b".repeat(5001) });
    expect(res.status).toBe(400);
    expect(parse(res.text).querySelector("#description-error")?.text).toBe(
      "Must be at most 5000 characters. It is 1 character over.",
    );
  });

  it("adds nothing to other messages", async () => {
    const { app } = buildTestApp();
    const res = await as(app, customerOne)
      .post("/tickets")
      .type("form")
      .send({ title: "Printer jams", description: "" });
    expect(parse(res.text).querySelector("#description-error")?.text).toBe("Must not be empty.");
  });
});

describe("the count under the box", () => {
  it("shows only near the limit, and says how far over past it", () => {
    expect(countWords(4499, 5000)).toBeNull();
    expect(countWords(4500, 5000)).toBe("4,500 of 5,000 characters.");
    expect(countWords(5000, 5000)).toBe("5,000 of 5,000 characters.");
    expect(countWords(7200, 5000)).toBe("7,200 of 5,000 characters, 2,200 over.");
  });

  it("updates as the person types or pastes, counting line breaks once", () => {
    let typed: () => void = () => undefined;
    const box: CountedBox = {
      value: "",
      dataset: { countLimit: "10" },
      addEventListener: (_type, listener) => (typed = listener),
    };
    const line: CountLine = { textContent: null, hidden: true };
    wireCount(box, line);
    expect(line.hidden).toBe(true);
    box.value = "abcd\r\nefghijk";
    typed();
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe("12 of 10 characters, 2 over.");
  });
});
