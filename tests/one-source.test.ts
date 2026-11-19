import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPES, DEMO_SCOPES } from "../src/server/connections/service.js";
import { LIST_PAGE_SIZE } from "../src/server/tickets/service.js";
import { buildTestApp, ticketServiceFiles, visitor } from "./helpers.js";

// A value said in two places drifts apart when one of them changes, so each of these is written
// once and read from there.

const sources = fs
  .readdirSync("src/server", { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => fs.readFileSync(path.join("src/server", file), "utf8"))
  .join("\n");

describe("values written once", () => {
  it.each([
    ["the untrusted-text warning", "is written by customers"],
    ["the demo-not-ready message", "Assistant connections are off on this demo"],
    ["the http link rule", "Must be a link that starts with http or https."],
  ])("%s is in the source once", (_name, words) => {
    expect(sources.split(words)).toHaveLength(2);
  });

  it("who wrote a history entry is filled in by one helper in the ticket service", () => {
    const service = ticketServiceFiles()
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    expect(service.split("context: agentContext(actor)")).toHaveLength(2);
  });

  it("the demo's scopes are the default scopes", () => {
    expect(DEMO_SCOPES).toBe(DEFAULT_SCOPES);
  });

  it("the guide's page size is the one the list uses", async () => {
    const guide = (await visitor(buildTestApp().app).get("/api")).body;
    expect(guide.limits.list_page).toBe(LIST_PAGE_SIZE);
    expect(JSON.stringify(guide)).toContain(`pages of ${LIST_PAGE_SIZE}.`);
    expect(sources).not.toMatch(/pages of 100|list_page: 100/);
  });
});
