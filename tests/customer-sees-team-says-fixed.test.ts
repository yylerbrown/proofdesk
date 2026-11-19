import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// When the team resolves a ticket as fixed without the customer's Yes, the customer's ticket says
// so in their terms: "The team says it is fixed", and beneath it "You have not confirmed it",
// with the way to reopen it. The team keeps its own wording. In the list the status is one word
// for everyone, with no check mark, since the customer did not confirm it.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

async function resolvedByTeam(reason: string, extra: object = {}) {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  const res = await as(app, teamActor)
    .post("/api/tickets/SUP-1/resolve")
    .send({ reason, ...extra });
  expect(res.status).toBe(200);
  const page = async (who: typeof teamActor, path: string) =>
    parse((await as(app, who).get(path)).text);
  return { page };
}

/** The status cell of the list's row for SUP-1, as text. */
function statusCell(list: ReturnType<typeof parse>): string {
  const row = list
    .querySelectorAll("table.tickets tbody tr")
    .find((tr) => tr.querySelector("td")?.text.trim() === "SUP-1")!;
  return row.querySelectorAll("td")[2]!.text.trim();
}

describe("a ticket the team resolved as fixed, for its customer", () => {
  it("shows only Resolved in the list, for the customer and the team", async () => {
    const { page } = await resolvedByTeam("fixed_no_reply");
    expect(statusCell(await page(customerOne, "/tickets"))).toBe("Resolved");
    expect(statusCell(await page(teamActor, "/tickets"))).toBe("Resolved");
  });

  it("says the same on their ticket, with the way to reopen it", async () => {
    const { page } = await resolvedByTeam("fixed_no_reply");
    const ticket = await page(customerOne, "/tickets/SUP-1");
    const card = ticket.querySelector(".ticket-card")!;
    expect(card.querySelector(".card-line")?.text.trim()).toBe(
      "The team says it is fixed. You have not confirmed it.",
    );
    expect(card.querySelector("details#reopen summary")?.text).toBe("Still happening?");
    // The team reads the reason, who and when, and that the customer has not confirmed it.
    const team = await page(teamActor, "/tickets/SUP-1");
    expect(team.querySelector(".ticket-card .card-line")?.text.trim()).toMatch(
      /^Resolved by the team: Fixed\. .+, \d{1,2} [A-Z][a-z]{2} \d{4}\. Not confirmed by the customer\.$/,
    );
  });

  it("leaves the team's other reasons as they are, since they do not claim a fix", async () => {
    const { page } = await resolvedByTeam("wont_fix", { note: "Works as designed." });
    expect(statusCell(await page(customerOne, "/tickets"))).toBe("Resolved");
    const ticket = await page(customerOne, "/tickets/SUP-1");
    expect(ticket.querySelector(".ticket-card .card-line")?.text.trim()).toBe(
      "Resolved by the team: Won't fix (Works as designed). You have not confirmed it.",
    );
  });
});
