import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The architecture notes say what the code is, so a reader can trust them: the routes are not
// called thin, and every name in the "Names in the code" table is a name the code really uses.

const notes = fs.readFileSync("docs/ARCHITECTURE.md", "utf8");

/** Every .ts and .ejs file under a folder, read into one string. */
function readAll(folder: string): string {
  return fs
    .readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|ejs)$/.test(entry.name))
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("the architecture notes", () => {
  it("do not call the routes thin", () => {
    expect(notes).not.toMatch(/thin routes/);
  });

  it("list in the names table only names the code uses", () => {
    const section = notes.split("## Names in the code")[1] ?? "";
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.includes("---"));
    // The header row and at least the five names the table was written with.
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const code = readAll("src") + readAll("views");
    for (const row of rows.slice(1)) {
      const names = [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
      expect(names.length, row).toBeGreaterThan(0);
      for (const name of names) {
        // `done_when.customer_check` is read as two fields, and `ready_*` as a prefix.
        const last = name.split(".").pop() ?? name;
        expect(code, name).toContain(last.replace("*", ""));
      }
    }
  });
});
