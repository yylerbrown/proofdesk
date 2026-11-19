import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// What the README and the specification say about the product must match what has merged:
// whether email goes out, and who may reopen a resolved ticket.

const readme = fs.readFileSync("README.md", "utf8").replace(/\s+/g, " ");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("the README's known limits", () => {
  // The notices module writes an outbox. Until something outside it calls it, no email goes
  // out, and the README must say so; once something does, the sentence must change.
  it("says no email is sent yet exactly while nothing outside the notices module uses it", () => {
    const callers = sourceFiles("src")
      .filter((file) => !file.split(path.sep).includes("notify"))
      .filter((file) => /from "\.{1,2}\/(\.\.\/)*notify\//.test(fs.readFileSync(file, "utf8")));
    expect(
      readme.includes("No email is sent yet."),
      "once email goes out, change the No email line in the README's Known limits",
    ).toBe(callers.length === 0);
    expect(readme).not.toContain("**No email.**");
  });
});

describe("who may reopen a resolved ticket, in the README and the specification", () => {
  it("includes the team for its own resolution, never for the customer's Yes", () => {
    expect(readme).toContain("reopen it if the team resolved it");
    expect(readme).toContain("reopen any ticket the team resolved");
    const spec = fs.readFileSync("docs/SPEC.md", "utf8").replace(/\s+/g, " ");
    expect(spec).not.toContain("Only the customer who filed a resolved ticket can reopen it");
    expect(spec).toContain("never one the customer confirmed");
  });

  it("names the Resolve button the ticket page really shows", () => {
    const page = fs.readFileSync("views/ticket-show.ejs", "utf8");
    // The Status menu's Resolved opens the reasons; its form's button is Resolve ticket.
    expect(page).toContain('?step=resolve">');
    expect(page).toMatch(/<button type="submit"[^>]*>Resolve ticket<\/button>/);
    expect(readme).toContain('press "Resolve with a reason…" under Status');
    expect(readme).not.toContain('open "Resolve with a reason"');
  });
});
