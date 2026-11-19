import { HTMLElement, parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// With scripts on, the ticket list's bar is moved out of its form into a dock over the filter
// row. Each of its controls names the form, so Apply still sends the ticked rows and the choices
// from there; a control that did not would be dropped from the post without a word.

describe("the bar laid over the filter row", () => {
  it("has a dock at the top of the list, before the filters, and every control names the form", async () => {
    const { app } = buildTestApp();
    const filed = await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Export is empty", description: "x", fix_check: "It works" });
    expect(filed.status).toBe(201);
    const page = parse((await as(app, teamActor).get("/tickets")).text);

    // The list's area starts with the dock, then the filter row.
    const area = page.querySelector(".list-area")!;
    const firstTwo = area.childNodes.filter((node) => node instanceof HTMLElement).slice(0, 2);
    expect(firstTwo.map((element) => element.hasAttribute("data-bulk-dock"))).toEqual([
      true,
      false,
    ]);
    expect(firstTwo[1]!.hasAttribute("data-list-filters")).toBe(true);

    const form = page.querySelector("form[data-bulk]")!;
    const formId = form.getAttribute("id");
    expect(formId).toBeTruthy();
    const controls = page.querySelectorAll(
      "[data-bulk-bar] select, [data-bulk-bar] button[type=submit]",
    );
    expect(controls.map((control) => control.getAttribute("name") ?? control.text.trim())).toEqual([
      "status",
      "reason",
      "owner",
      "Apply",
    ]);
    for (const control of controls) expect(control.getAttribute("form")).toBe(formId);
  });

  it("has no dock when the list is empty, since there is no bar", async () => {
    const { app } = buildTestApp();
    const page = parse((await as(app, teamActor).get("/tickets")).text);
    expect(page.querySelector("[data-bulk-dock]")).toBeNull();
    expect(page.querySelector("[data-list-filters]")).not.toBeNull();
  });
});
