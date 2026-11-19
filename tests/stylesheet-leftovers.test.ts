import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TICKET_STATUSES } from "../src/server/tickets/schemas.js";

// The stylesheet keeps no rules for things the pages no longer draw. Every class a rule names
// must still be written somewhere in the views or the server and browser code.

/** Every file under a folder, read as text. */
function readAll(folder: string): string[] {
  const entries = fs.readdirSync(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
}

/** The class names in the stylesheet's selectors, leaving out comments and declarations. */
function stylesheetClasses(): string[] {
  const css = fs.readFileSync("public/site.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((match) => match[1]!);
  const names = new Set<string>();
  for (const selector of selectors) {
    if (selector.trim().startsWith("@")) continue;
    for (const match of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) names.add(match[1]!);
  }
  return [...names];
}

describe("the stylesheet", () => {
  it("styles only classes that a view or the code still writes", () => {
    const source = [...readAll("views"), ...readAll("src")].join("\n");
    // The status badge builds its class from the ticket's status: status-<status>.
    const built = TICKET_STATUSES.map((status) => `status-${status}`);
    const unused = stylesheetClasses().filter((name) => {
      if (built.includes(name)) return false;
      const written = new RegExp(`(?<![\\w-])${name}(?![\\w-])`);
      return !written.test(source);
    });
    expect(unused).toEqual([]);
  });
});
