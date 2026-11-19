import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, resolveTicket, teamActor } from "./helpers.js";

// The list's status cell is one line for everyone: the status word only. A ticket the customer
// confirmed carries a small check mark after "Resolved", named "Customer confirmed" for a screen
// reader and in its tooltip. A ticket the team resolved carries nothing extra in the list.

const valid = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };

/** The status cell of each row, keyed by ticket. */
async function statusCells(app: Parameters<typeof as>[0], who: typeof teamActor) {
  const list = parse((await as(app, who).get("/tickets")).text);
  const cells: Record<string, ReturnType<typeof parse>> = {};
  for (const row of list.querySelectorAll("table.tickets tbody tr")) {
    const tds = row.querySelectorAll("td");
    cells[tds[0]!.text.trim()] = tds[2]!;
  }
  return cells;
}

describe("the list's status cell", () => {
  it("is the status word, with a check mark only for the customer's Yes", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, customerOne).post("/api/tickets").send(valid);
    await resolveTicket(app, "SUP-1", customerOne);
    await as(app, teamActor).post("/api/tickets/SUP-2/resolve").send({ reason: "fixed_no_reply" });

    for (const who of [customerOne, teamActor]) {
      const cells = await statusCells(app, who);
      expect(cells["SUP-1"]!.text.trim()).toBe("Resolved ✓");
      const mark = cells["SUP-1"]!.querySelector(".confirmed-mark")!;
      expect(mark.getAttribute("role")).toBe("img");
      expect(mark.getAttribute("aria-label")).toBe("Customer confirmed");
      expect(mark.getAttribute("title")).toBe("Customer confirmed");
      // The team's resolution is the plain word: its reason stays on the ticket's page.
      expect(cells["SUP-2"]!.text.trim()).toBe("Resolved");
      expect(cells["SUP-2"]!.querySelector(".confirmed-mark")).toBeNull();
    }
  });
});
