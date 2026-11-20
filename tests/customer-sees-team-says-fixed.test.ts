import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// When the team marks a ticket fixed, it is resolved at once and the customer's ticket asks them
// "Did this fix it?": the team says it is fixed, and they can say Yes or No. The team keeps its own
// wording. In the list the status is one word with no check mark, since the customer did not
// confirm it; the customer's own row adds the question, linked to where they answer it.

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
  it("shows Resolved in the list, and asks the customer on their own row", async () => {
    const { page } = await resolvedByTeam("fixed_no_reply");
    const mine = await page(customerOne, "/tickets");
    expect(statusCell(mine)).toBe("Resolved Needs your answer");
    expect(mine.querySelector("a.turn-tag")?.getAttribute("href")).toBe(
      "/tickets/SUP-1#did-this-fix-it",
    );
    expect(statusCell(await page(teamActor, "/tickets"))).toBe("Resolved");
  });

  it("asks the customer Did this fix it?, with Yes and a No that reopens it", async () => {
    const { page } = await resolvedByTeam("fixed_no_reply");
    const ticket = await page(customerOne, "/tickets/SUP-1");
    const card = ticket.querySelector("#did-this-fix-it")!;
    expect(card.querySelector("h2")?.text).toBe("Did this fix it?");
    expect(card.querySelector("blockquote")?.text).toBe("Ten pages print");
    // It is said once, in the line under the title, and not again on the card.
    expect(ticket.querySelector(".ticket-standing")?.text).toBe(
      "Resolved, the team says it is fixed",
    );
    expect(card.text).not.toContain("The team says it is fixed");
    expect(card.text).not.toContain("Fixed in:");
    // The question replaces the old line and the old way to reopen.
    expect(card.querySelector(".card-line")).toBeNull();
    expect(ticket.querySelector("details#reopen")).toBeNull();
    const yes = card.querySelector(".card-answer > form")!;
    expect(yes.getAttribute("action")).toBe("/tickets/SUP-1/confirm");
    expect(yes.querySelector("button")?.text).toBe("Yes, it is fixed");
    expect(yes.querySelector("input[name=expected_version]")).not.toBeNull();
    const no = card.querySelector("details.answer-no")!;
    expect(no.hasAttribute("open")).toBe(false);
    expect(no.querySelector("summary")?.text).toBe("No, it is not fixed");
    expect(no.querySelector("form")?.getAttribute("action")).toBe("/tickets/SUP-1/reopen");
    expect(no.querySelector("label")?.text).toBe("What is still wrong?");
    expect(no.querySelector("textarea[name=reason]")?.hasAttribute("required")).toBe(true);
    expect(no.querySelector("button")?.text).toBe("No, send it back");
    // The team reads the reason, who and when, and that the customer has not confirmed it.
    const team = await page(teamActor, "/tickets/SUP-1");
    expect(team.querySelector("#did-this-fix-it")).toBeNull();
    expect(team.querySelector(".ticket-card .card-line")?.text.trim()).toMatch(
      /^Resolved by the team: Fixed\. .+, \d{1,2} [A-Z][a-z]{2} \d{4}\. The customer has not confirmed it\.$/,
    );
  });

  it("says where it is fixed, with Fixed in, to both of them", async () => {
    const { page } = await resolvedByTeam("fixed_no_reply", { note: "version 4.2.1" });
    const card = (await page(customerOne, "/tickets/SUP-1")).querySelector("#did-this-fix-it")!;
    expect(card.querySelectorAll(".card-detail").map((line) => line.text.trim())).toEqual([
      "Fixed in: version 4.2.1",
    ]);
    const team = await page(teamActor, "/tickets/SUP-1");
    expect(team.querySelector(".ticket-card .card-line")?.text.trim()).toMatch(
      /^Resolved by the team: Fixed\. Fixed in: version 4\.2\.1\. /,
    );
    const history = team.querySelectorAll("details.history tbody tr").map((row) => row.text);
    expect(
      history.some((row) =>
        row.includes(
          "Resolved by the team: Fixed. Agreed that what would prove it is fixed was met. Not customer-confirmed. Fixed in: version 4.2.1.",
        ),
      ),
    ).toBe(true);
  });

  it("leaves the team's other reasons as they are, since they do not claim a fix", async () => {
    const { page } = await resolvedByTeam("wont_fix", { note: "Works as designed." });
    expect(statusCell(await page(customerOne, "/tickets"))).toBe("Resolved");
    const ticket = await page(customerOne, "/tickets/SUP-1");
    expect(ticket.querySelector(".ticket-card .card-line")?.text.trim()).toBe(
      "Won't fix (Works as designed). You have not confirmed it.",
    );
  });
});
