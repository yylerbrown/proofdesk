import { describe, expect, it } from "vitest";
import { samplePicture } from "../src/server/pictures/sample.js";
import { as, buildTestApp, customerOne } from "./helpers.js";

// A picture on a ticket is a private answer like every other page, so no browser keeps it.
// Someone who loses access to the ticket then loses the picture at once, not an hour later.

describe("a ticket's picture", () => {
  it("is answered no-store, like every other private page", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/tickets")
      .field("title", "Printer jams")
      .field("description", "It jams on page two.")
      .attach("pictures", samplePicture(), "jam.png");
    const loaded = await as(app, customerOne).get("/tickets/SUP-1/pictures/1");
    expect(loaded.status).toBe(200);
    expect(loaded.headers["cache-control"]).toBe("private, no-store");
    expect(loaded.headers["cache-control"]).not.toContain("max-age");
  });
});
