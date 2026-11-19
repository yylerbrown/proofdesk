import { describe, expect, it, vi } from "vitest";
import { parse } from "node-html-parser";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The ticket page names the people in its history and offers the team members a ticket can be
// handed to. It reads only those people from the sign-in tables, never everyone who ever
// signed in, so it does not slow down as more customers sign in.

type Built = ReturnType<typeof buildTestApp>;

/** Puts people who signed in with GitHub straight into the sign-in tables, as customers. */
function addSignedInCustomers(db: Built["db"], count: number, from = 0): void {
  const now = new Date().toISOString();
  const user = db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, ?, ?)`,
  );
  const account = db.prepare(
    `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
     VALUES (?, ?, 'github', ?, ?, ?)`,
  );
  for (let i = from; i < from + count; i++) {
    user.run(`customer-${i}`, `Customer ${i}`, `customer-${i}@example.com`, now, now);
    account.run(`account-${i}`, String(50000 + i), `customer-${i}`, now, now);
  }
}

/**
 * Opens the ticket page as the team and notes each statement that reads the sign-in tables,
 * with how many rows those statements gave back in all.
 */
async function peopleReads(built: Built): Promise<{ statements: string[]; rows: number }> {
  const prepare = built.db.prepare.bind(built.db);
  const statements: string[] = [];
  let rows = 0;
  const spy = vi.spyOn(built.db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (!/"user"/.test(sql)) return statement;
    statements.push(sql);
    const all = statement.all.bind(statement);
    statement.all = (...values: unknown[]) => {
      const found = all(...values);
      rows += found.length;
      return found;
    };
    return statement;
  });
  const res = await as(built.app, teamActor).get("/tickets/SUP-1");
  spy.mockRestore();
  expect(res.status).toBe(200);
  return { statements, rows };
}

/** How SQLite reads a statement, with a JSON empty list bound to each placeholder. */
function plan(db: Built["db"], sql: string): string[] {
  const placeholders = (sql.match(/\?/g) ?? []).length;
  const values = Array.from({ length: placeholders }, () => "[]");
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as { detail: string }[]).map(
    (row) => row.detail,
  );
}

async function withTicket(env: NodeJS.ProcessEnv = {}): Promise<Built> {
  const built = buildTestApp(env);
  await as(built.app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "x" });
  return built;
}

describe("the people a ticket page reads", () => {
  it("never scans everyone who signed in, however many customers there are", async () => {
    const built = await withTicket({ TEAM_GITHUB_IDS: "50003" });
    addSignedInCustomers(built.db, 200);
    const { statements } = await peopleReads(built);
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) {
      const steps = plan(built.db, sql).join(" | ");
      // A scan of the user or account table reads one row per person who ever signed in.
      expect(steps, sql).not.toMatch(/SCAN (u|a)\b/);
    }
  });

  it("reads as many people with 10 customers signed in as with 300", async () => {
    const built = await withTicket();
    addSignedInCustomers(built.db, 10);
    const few = await peopleReads(built);
    addSignedInCustomers(built.db, 290, 10);
    expect(await peopleReads(built)).toEqual(few);
  });

  it("still offers the team members named in the settings or chosen on the People page", async () => {
    const built = await withTicket({ TEAM_GITHUB_IDS: "50003" });
    addSignedInCustomers(built.db, 20);
    // An admin chose customer 7 as a team member on the People page.
    built.db
      .prepare("INSERT INTO people_roles (person_id, role, updated_at) VALUES (?, 'team', ?)")
      .run("customer-7", new Date().toISOString());
    await as(built.app, teamActor).post("/api/tickets/SUP-1/take");
    const page = parse((await as(built.app, teamActor).get("/tickets/SUP-1")).text);
    const offered = page
      .querySelectorAll("select[name=to] option")
      .map((option) => option.text.trim());
    expect(offered).toContain("Customer 3");
    expect(offered).toContain("Customer 7");
    expect(offered).not.toContain("Customer 4");
  });
});
