import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { markReadySchema } from "../src/server/tickets/schemas.js";

// The README and the docs must say what the product does now. Each check below ties a sentence
// in the docs to the code that makes it true, so the words cannot fall behind the product again.

const flat = (file: string) => fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
const readme = flat("README.md");
const spec = flat("docs/SPEC.md");
const deploy = flat("docs/DEPLOY.md");
const architecture = flat("docs/ARCHITECTURE.md");
const api = fs.readFileSync("docs/API.md", "utf8");

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(" ## ", start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

function apiRow(route: string): string {
  const row = api.split("\n").find((line) => line.startsWith(`| \`${route}\``));
  expect(row, route).toBeDefined();
  return row!;
}

describe("roles, as the docs describe them", () => {
  const peopleRoutes = fs.readFileSync("src/server/routes/people.ts", "utf8");

  it("name the People page and the account page the server serves", () => {
    expect(peopleRoutes).toContain('router.get("/people"');
    expect(peopleRoutes).toContain('router.get("/account"');
    const roles = section(readme, "## Sign-in and roles");
    expect(roles).toContain("An admin chooses who is on the team on the **People** page");
    expect(roles).toContain("account page, with a switch for email notices");
    expect(roles).toContain("An admin chooses it on **People**");
    expect(deploy).toContain("People page");
  });

  it("no longer say roles are only set in the settings, or that people screens were left out", () => {
    expect(readme).not.toContain("there is no page for it yet");
    expect(readme).not.toContain("Everyone else is a customer.");
    expect(readme).toContain("keep that role and show as locked on **People**");
    expect(spec).toContain("### 2026-11-18, afternoon: people, email and a shorter ask");
    expect(spec).toContain('This replaces "screens for managing people"');
  });
});

describe("the status path, as the docs describe it", () => {
  it("lists every field of the ask as optional, as the schema takes them", () => {
    const row = apiRow("POST /api/tickets/:key/ready");
    expect(markReadySchema.safeParse({}).success).toBe(true);
    for (const field of Object.keys(markReadySchema.shape)) {
      expect(row, field).toContain(`"${field}"?`);
    }
    expect(row).not.toContain("change link");
    expect(architecture).not.toContain("the change is linked");
  });

  it("says a team member may resolve a ticket nobody owns", () => {
    expect(apiRow("POST /api/tickets/:key/resolve")).toContain(
      "A team member may resolve a ticket nobody owns and becomes its owner.",
    );
    expect(architecture).toContain("so can a team member when nobody owns it yet");
    expect(readme).toContain("a New ticket nobody owns");
    expect(spec).toContain("also a team member for a ticket nobody owns, who becomes its owner");
  });

  it("names no sample fix, which the ticket page no longer offers", () => {
    expect(fs.readFileSync("views/ticket-show.ejs", "utf8")).not.toContain("Use sample fix");
    for (const text of [readme, api, architecture, deploy]) {
      expect(text).not.toContain("Use sample fix");
    }
  });
});

describe("email notices, as the README describes them", () => {
  it("says how they are sent and where the demo shows them", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toHaveProperty("nodemailer");
    const notices = fs.readFileSync("src/server/routes/notices.ts", "utf8");
    expect(notices).toContain('router.get("/tickets/:key/notices"');

    const limits = section(readme, "## Known limits");
    expect(limits).toContain("written to an outbox from the ticket history");
    expect(limits).toContain("sent with nodemailer only once `SMTP_URL` and `MAIL_FROM` are set");
    expect(limits).toContain("The demo never sends");
    expect(limits).not.toContain("nobody can turn them off");
    const features = section(readme, "## Try each feature in a minute");
    expect(features).toContain("(`/tickets/SUP-1/notices`)");
  });
});

describe("the README's feature list and the code map", () => {
  it("drops the rows that only restate the links at the top", () => {
    expect(readme).not.toContain("**A live URL**");
    expect(readme).not.toContain("**Source on GitHub, and a README on how to run it**");
  });

  it("says what the top-level ops/prove folder is, outside Known limits", () => {
    const before = readme.slice(0, readme.indexOf("## Known limits"));
    expect(before).toContain("The top-level `ops/prove` folder is a command-line check");
    expect(fs.existsSync("ops/prove/README.md")).toBe(true);
  });

  it("says can() decides by role, scope and filer, and the service checks the rest", () => {
    expect(architecture).toContain(
      "`can()` in `src/server/permissions.ts` decides by role, by agent scope and by who filed the ticket",
    );
    expect(architecture).toContain(
      "Who owns the ticket and the order of the workflow are checked in the ticket service",
    );
  });
});

describe("the package name", () => {
  it("is the product's name in package.json and its lock file", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { name: string };
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as {
      name: string;
      packages: Record<string, { name?: string }>;
    };
    expect(pkg.name).toBe("proofdesk");
    expect(lock.name).toBe("proofdesk");
    expect(lock.packages[""]!.name).toBe("proofdesk");
  });
});

describe("the build log", () => {
  it("has a row for each pull request merged on the afternoon of 18 November", () => {
    const log = fs.readFileSync("BUILD_LOG.md", "utf8");
    for (const pr of [133, 134, 135, 136, 137, 138, 139, 141, 142]) {
      expect(log, `#${pr}`).toMatch(new RegExp(`\\| #${pr} +\\|`));
    }
  });
});
