import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// When the team resolves a ticket as fixed without the customer's Yes, the customer's list and
// ticket say so in their terms: "The team says it is fixed", and beneath it "You have not
// confirmed it", with the way to reopen it. The team keeps its own wording.

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

/** The words under the status in the list's row for SUP-1. */
function rowLabels(list: ReturnType<typeof parse>): string[] {
  const row = list
    .querySelectorAll("table.tickets tbody tr")
    .find((tr) => tr.querySelector("td")?.text.trim() === "SUP-1")!;
  return row.querySelectorAll(".resolution-label").map((label) => label.text);
}

describe("a ticket the team resolved as fixed, for its customer", () => {
  it("says the team says it is fixed and they have not confirmed it, in the list", async () => {
    const { page } = await resolvedByTeam("fixed_no_reply");
    expect(rowLabels(await page(customerOne, "/tickets"))).toEqual([
      "The team says it is fixed",
      "You have not confirmed it",
    ]);
    // The team's list keeps its own words.
    expect(rowLabels(await page(teamActor, "/tickets"))).toEqual([
      "By the team: Fixed. Not customer-confirmed.",
    ]);
  });

  it("says the same on their ticket, with the way to reopen it", async () => {
    const { page } = await resolvedByTeam("fixed_no_reply");
    const ticket = await page(customerOne, "/tickets/SUP-1");
    const card = ticket.querySelector("article.resolved-by-team")!;
    expect(card.querySelector("strong")?.text).toBe("The team says it is fixed");
    expect(card.text).toContain("You have not confirmed it.");
    expect(ticket.querySelector("details#reopen summary")?.text).toBe("Still happening?");
    // The team's ticket keeps the label it had.
    const team = await page(teamActor, "/tickets/SUP-1");
    expect(team.querySelector("article.resolved-by-team strong")?.text).toBe(
      "Resolved by the team: Fixed. Not customer-confirmed.",
    );
  });

  it("leaves the team's other reasons as they are, since they do not claim a fix", async () => {
    const { page } = await resolvedByTeam("wont_fix", { note: "Works as designed." });
    expect(rowLabels(await page(customerOne, "/tickets"))).toEqual(["By the team: Won't fix"]);
    const ticket = await page(customerOne, "/tickets/SUP-1");
    expect(ticket.querySelector("article.resolved-by-team strong")?.text).toBe(
      "Resolved by the team: Won't fix",
    );
  });
});
