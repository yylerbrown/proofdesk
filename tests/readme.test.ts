import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/server/api/actions.js";

// The README's list of API routes must be the routes there are: none missing, none invented.

describe("the README's API table", () => {
  it("lists every route in the action table, and no route that is not there", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const table = readme.slice(readme.indexOf("### JSON API"), readme.indexOf("### Security"));
    const listed = [...table.matchAll(/^\| `(GET|POST|PUT|PATCH|DELETE) (\/api\/[^`]+)`/gm)]
      .map((m) => `${m[1]} ${m[2]}`)
      .filter((route) => route !== "GET /api/health")
      .sort();
    const routes = ACTIONS.map((row) => `${row.method.toUpperCase()} /api${row.path}`).sort();
    expect(listed).toEqual(routes);
  });
});
