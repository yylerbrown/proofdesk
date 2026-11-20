import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The docs describe roles as the product has them: one table in the code, a page that uses the
// server's check and adds ownership, a check before a role change, and a log of changes that cannot be edited.
// Each claim is tied to the code that makes it true.

const flat = (file: string) => fs.readFileSync(file, "utf8").replace(/\s+/g, " ");

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(" ## ", start + heading.length);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

describe("roles, in the README", () => {
  const roles = section(flat("README.md"), "## Sign-in and roles");

  it("say who may do what is one table, and the page uses the server's check plus ownership", () => {
    expect(roles).toContain("Who may do what is one table in the code");
    expect(roles).toContain("(src/server/permissions.ts)");
    expect(fs.readFileSync("src/server/permissions.ts", "utf8")).toContain("export function can(");
    expect(roles).toContain("**Who may do what** (`/roles`), open to anyone");
    expect(roles).toContain(
      "uses the server's own permission check and adds who must own the ticket.",
    );
    expect(fs.readFileSync("src/server/routes/roles.ts", "utf8")).toContain('router.get("/roles"');
  });

  // The page adds the ownership rules the ticket service keeps through a small overlay, so no
  // doc may say the page and the rules cannot disagree.
  it("never claim the page and the rules cannot disagree", () => {
    const sentence =
      "This page uses the server's own permission check and adds who must own the ticket.";
    for (const file of ["README.md", "docs/TOUR.md", "docs/SPEC.md"]) {
      expect(flat(file), file).not.toContain("so the page and the rules cannot disagree");
    }
    expect(flat("docs/TOUR.md")).toContain(`You should see: "${sentence}"`);
    expect(fs.readFileSync("src/server/roles-table.ts", "utf8")).toMatch(/overlay/i);
  });

  it("say Check this change shows a role change before it is made, and changes are logged", () => {
    expect(roles).toContain("Before a change is made, **Check this change** shows what it will do");
    expect(flat("views/people.ejs")).toContain("Check this change");
    expect(roles).toContain("every change is kept in a log that cannot be edited");
    const migration = fs.readFileSync("migrations/0028_people_roles.sql", "utf8");
    expect(migration).toContain("CREATE TRIGGER role_changes_no_update");
    expect(migration).toContain("CREATE TRIGGER role_changes_no_delete");
  });
});

describe("roles, in the tour and the specification", () => {
  it("give the tour a step for each role moment, with one picture of Who may do what", () => {
    const tour = flat("docs/TOUR.md");
    const roles = section(tour, "**Who may do what**");
    expect(roles).toContain("Team member (you)");
    expect(roles).toContain('src="img/who-may-do-what.png"');
    expect(fs.existsSync("docs/img/who-may-do-what.png")).toBe(true);
    const check = section(tour, "**Check a role change first**");
    expect(check).toContain("**Check this change**");
    expect(check).toContain("Demo Admin (read-only) changes nothing, so there is no button here.");
  });

  it("no longer say roles come only from configuration", () => {
    const spec = flat("docs/SPEC.md");
    expect(spec).toContain(
      "- **Admin:** a team member named in configuration. (Since 18 Nov an admin chooses",
    );
    expect(spec).toContain(
      "Team members and the admin are named in configuration. (Since 18 Nov they are chosen on People",
    );
    expect(spec).toContain("### 2026-11-20, afternoon: roles, shown and checked");
  });
});
