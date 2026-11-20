import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";

// The three suggestion tools are called by a connection, never by a person. Every description
// of who may call them says which connection, in the words of the connection's Suggestions
// setting, so an assistant reading any of them knows it may listen. The page, the guide and the
// OpenAPI description are built from the same table, so they agree.

const WHEN_ASKED =
  "A connection whose Suggestions setting is When asked or Automatic, never a person.";

describe("who may call the suggestion tools", () => {
  it("is a connection by its Suggestions setting on /llms.txt, never Nobody", async () => {
    const { app } = buildTestApp();
    const page = (await request(app).get("/llms.txt")).text;
    for (const tool of ["wait_for_requests", "answer_request"]) {
      const section = page.slice(page.indexOf(`### ${tool}`));
      const whoMay = section.split("\n").find((line) => line.startsWith("Who may:"));
      expect(whoMay, tool).toBe(
        `Who may: ${WHEN_ASKED} An assistant needs the scope \`suggest_when_asked\`.`,
      );
    }
    expect(page).not.toMatch(/Who may: Nobody/);
  });

  it("says the same in the guide at /api and in the OpenAPI description", async () => {
    const { app } = buildTestApp();
    const guide = (await request(app).get("/api")).body as {
      capabilities: { action: string; people: string }[];
    };
    const people = (action: string) => guide.capabilities.find((c) => c.action === action)?.people;
    expect(people("wait_for_requests")).toBe(WHEN_ASKED);
    expect(people("answer_request")).toBe(WHEN_ASKED);
    expect(people("suggest_checks")).toMatch(
      /^A connection whose Suggestions setting is Automatic/,
    );
    const openapi = JSON.stringify((await request(app).get("/api/openapi.json")).body);
    expect(openapi).toContain(`wait_for_requests: ${WHEN_ASKED}`);
    expect(openapi).toContain(`answer_request: ${WHEN_ASKED}`);
    expect(openapi).not.toContain("Nobody: an assistant");
  });
});
