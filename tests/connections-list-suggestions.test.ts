import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, buildTestApp } from "./helpers.js";

// The Connections list says each connection's Suggestions setting in its own words, before the
// other things it may do, and says when a revoked connection was revoked.

/** The "May" and "State" cells of the list's row for the connection with this name. */
async function rowOf(app: Parameters<typeof admin>[0], name: string) {
  const page = parse((await admin(app).get("/connections")).text);
  const link = page.querySelectorAll("table.connections a").find((a) => a.text === name)!;
  const cells = link.closest("tr")!.querySelectorAll("td");
  return {
    may: cells[2]!.text.replace(/\s+/g, " ").trim(),
    state: cells[4]!.text.replace(/\s+/g, " ").trim(),
    revokedTime: cells[4]!.querySelector("time")?.getAttribute("datetime") ?? null,
  };
}

describe("the Connections list", () => {
  it("says each connection's Suggestions setting before what else it may do", async () => {
    const { app } = buildTestApp();
    for (const [name, suggestions] of [
      ["Quiet", "off"],
      ["Asked", "when_asked"],
      ["Eager", "automatic"],
    ]) {
      const res = await admin(app)
        .post("/connections")
        .type("form")
        .send({ name, scopes: ["read_tickets"], suggestions });
      expect(res.status).toBe(200);
    }
    const reads = "Read the tickets handed to it and their conversations, without internal notes.";
    expect((await rowOf(app, "Quiet")).may).toBe(`Suggestions: Off. ${reads}`);
    expect((await rowOf(app, "Asked")).may).toBe(`Suggestions: When asked. ${reads}`);
    expect((await rowOf(app, "Eager")).may).toBe(`Suggestions: Automatic. ${reads}`);
    // The long sentences about the suggestion scopes are not repeated.
    expect((await rowOf(app, "Eager")).may).not.toContain("Suggest ways to verify");
  });

  it("says when a revoked connection was revoked", async () => {
    const { app } = buildTestApp();
    await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Old", scopes: ["read_tickets"] });
    const page = parse((await admin(app).get("/connections")).text);
    const revoke = page.querySelector("form[action$='/revoke']")!.getAttribute("action")!;
    expect((await admin(app).post(revoke)).status).toBe(303);
    const row = await rowOf(app, "Old");
    expect(row.state).toMatch(/^Revoked \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC$/);
    expect(row.revokedTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
