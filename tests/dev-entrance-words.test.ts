import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { buildTestApp, visitor } from "./helpers.js";

// The development entrance says, under each made-up person, one thing to try as them. Marking a
// ticket fixed resolves it at once and the customer's Yes is optional, so the words describe
// that, not the older way of asking the customer before resolving.

describe("the development entrance's one thing to try", () => {
  it("tells the team member to mark a ticket fixed, and the customer to follow it until then", async () => {
    const { app } = buildTestApp();
    const html = parse((await visitor(app).get("/sign-in")).text);
    expect(html.querySelector("#try-dev-team-1")?.text.trim()).toBe(
      "Take a ticket, write an internal note, and mark it fixed.",
    );
    expect(html.querySelector("#try-dev-customer-1")?.text.trim()).toBe(
      "File a ticket, then follow it until the team marks it fixed.",
    );
    const words = html.querySelector("main")!.text;
    expect(words).not.toContain("ask the customer to check");
    expect(words).not.toContain("asks whether it is fixed");
  });
});
