import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { arrowTarget } from "../src/browser/menus.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The ticket's Status menu: each choice with a side effect says it before it is pressed, and
// once a menu is open the arrow keys move between its choices.

describe("the Status menu's words", () => {
  it("says New unassigns a ticket someone owns, as In Progress says it assigns one", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "It jams on page two." });
    const team = as(app, teamActor);
    const words = async () =>
      parse((await team.get("/tickets/SUP-1")).text)
        .querySelectorAll("details.status-menu li")
        .map((item) => item.text.replace(/\s+/g, " ").trim());

    expect(await words()).toEqual(["New", "In Progress (assigns it to you)", "Resolved"]);
    await team.post("/api/tickets/SUP-1/take");
    await team.patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    expect(await words()).toEqual(["New (unassigns it)", "In Progress", "Resolved"]);
  });
});

describe("the arrow keys in an open menu", () => {
  it("go from the menu's button to the first choice, or up to the last", () => {
    expect(arrowTarget(3, -1, "ArrowDown")).toBe(0);
    expect(arrowTarget(3, -1, "ArrowUp")).toBe(2);
  });

  it("move to the next or the one before, wrapping round at either end", () => {
    expect(arrowTarget(3, 0, "ArrowDown")).toBe(1);
    expect(arrowTarget(3, 2, "ArrowDown")).toBe(0);
    expect(arrowTarget(3, 0, "ArrowUp")).toBe(2);
  });

  it("leave every other key, and a menu with no choices, alone", () => {
    expect(arrowTarget(3, 0, "Enter")).toBeNull();
    expect(arrowTarget(0, -1, "ArrowDown")).toBeNull();
  });
});
