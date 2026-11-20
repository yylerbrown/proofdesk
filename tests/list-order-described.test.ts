import request from "supertest";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/server/api/actions.js";
import { as, buildTestApp, customerOne } from "./helpers.js";

// The default list order, open_first, puts New tickets that say how to verify the fix before
// the other open tickets. The words that describe it, on /llms.txt and in the list_tickets
// tool, say so, so an older ticket with a check listed first is what they lead you to expect.

/** What /llms.txt says of open_first: the words after it, up to the next order it names. */
function openFirstWords(page: string): string {
  const start = page.indexOf("open_first (the default):");
  expect(start).toBeGreaterThan(0);
  return page.slice(start, page.indexOf(" oldest:", start));
}

describe("the default list order is described as it is", () => {
  it("lists an older ticket with a check before a newer one without, as /llms.txt says", async () => {
    const { app } = buildTestApp();
    const older = await as(app, customerOne).post("/api/tickets").send({
      title: "Export is empty",
      description: "No rows.",
      fix_check: "The export holds every row",
    });
    expect(older.status, older.text).toBe(201);
    const newer = await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Export is slow", description: "It takes a minute." });
    expect(newer.status, newer.text).toBe(201);

    const listed = await as(app, customerOne).get("/api/tickets");
    expect(listed.status, listed.text).toBe(200);
    const keys = (listed.body as { key: string }[]).map((row) => row.key);
    expect(keys).toEqual([older.body.key, newer.body.key]);

    const words = openFirstWords((await request(app).get("/llms.txt")).text);
    expect(words).toContain("New tickets that say how to verify the fix first");
    expect(words).toContain("then the other open tickets");
    expect(words).not.toContain("open tickets newest first, then resolved ones");
  });

  it("says the same in the list_tickets tool", () => {
    const list = ACTIONS.find((row) => row.name === "list_tickets")!;
    expect(list.summary).toContain("New ones that say how to verify the fix first");
    expect(list.summary).not.toContain("open ones newest first, then resolved ones");
  });
});
