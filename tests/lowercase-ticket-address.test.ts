import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// A ticket's address typed in lower case opens the ticket at its own address, as the list's
// search already does for "sup-3". A key that is still not valid answers as before.

describe("a ticket address in lower case", () => {
  it("sends the browser to the ticket's own address", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    const res = await as(app, teamActor).get("/tickets/sup-1");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/tickets/SUP-1");
    expect((await as(app, customerOne).get("/tickets/Sup-1")).headers.location).toBe(
      "/tickets/SUP-1",
    );
  });

  it("answers as before for a key that is not valid or not this person's", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    const before = await as(app, teamActor).get("/tickets/sup-x");
    expect(before.status).toBe(400);
    expect(before.text).toContain("That is not a valid ticket key.");
    // Another customer's ticket is not opened, and is not told apart from a bad key.
    const other = await as(app, customerTwo).get("/tickets/sup-1");
    expect(other.headers.location).toBeUndefined();
    expect(other.status).toBe(400);
  });
});
