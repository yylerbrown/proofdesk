import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Before the owner presses "Ask the customer to verify", the top of the ticket says in one line
// what the customer will check, so the owner reads it before asking.

async function ownedTicket(fields: Record<string, string>) {
  const { app } = buildTestApp();
  await as(app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "It jams on page two.", ...fields });
  const page = async (who = teamActor) => parse((await as(app, who).get("/tickets/SUP-1")).text);
  return { app, page };
}

describe("the customer's check above the ask", () => {
  it("is shown to the owner of an In Progress ticket, before the button", async () => {
    const { app, page } = await ownedTicket({ fix_check: "Ten pages print" });
    // Before anyone takes it, the top button is "Take ticket and start work", with no check line.
    expect((await page()).querySelector(".next-action .next-check")).toBeNull();

    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const next = (await page()).querySelector(".next-action")!;
    expect(next.querySelector(".next-check")?.text).toBe(
      "The customer will check: Ten pages print",
    );
    // It comes before the button, which keeps its label.
    expect(next.innerHTML.indexOf("next-check")).toBeLessThan(next.innerHTML.indexOf("<form"));
    expect(next.querySelector("form button")?.text).toBe("Ask the customer to verify");
  });

  it("says plainly when the customer gave no check", async () => {
    const { app, page } = await ownedTicket({});
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    expect((await page()).querySelector(".next-action .next-check")?.text).toBe(
      "The customer gave no check.",
    );
  });

  it("names the team's check when the customer gave none", async () => {
    const { app, page } = await ownedTicket({});
    await admin(app)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: "Twenty pages print in a row" });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    expect((await page()).querySelector(".next-action .next-check")?.text).toBe(
      "The customer will check the team's check: Twenty pages print in a row",
    );
  });

  it("is not shown to anyone who has no ask to make", async () => {
    const { app, page } = await ownedTicket({ fix_check: "Ten pages print" });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    // The admin does not own it, and the customer is the one who checks.
    expect((await page(customerOne)).querySelector(".next-check")).toBeNull();
    expect(
      parse((await admin(app).get("/tickets/SUP-1")).text).querySelector(".next-check"),
    ).toBeNull();
  });
});
