import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, type Role } from "../src/server/actor.js";
import { CAPABILITIES, can, type Action } from "../src/server/permissions.js";
import {
  ACTION_GROUPS,
  ACTION_WORDS,
  OWNER_ACTIONS,
  STAND_INS,
  rolesTable,
} from "../src/server/roles-table.js";
import { SCOPE_LABELS } from "../src/server/routes/connections.js";
import { allowedActions } from "../src/server/tickets/allowed-actions.js";
import type { Ticket } from "../src/server/tickets/types.js";
import { as, buildTestApp, teamActor, visitor } from "./helpers.js";

// The page "Who may do what" starts from can(), the server's own permission check, and adds a
// small overlay, typed by hand, for the owner rules that live in the ticket service. These tests
// tie the page to the check and the overlay to the ticket service's own rules.

const actions = Object.keys(CAPABILITIES) as Action[];
const rows = rolesTable(SCOPE_LABELS).flatMap((group) => group.rows);
const DEMO = { DEMO: "on", DEV_SIGN_IN: "off" };

/** The header words of the table's four role columns, in order. */
async function headersFor(env: Record<string, string>, who: (typeof DEMO_ACTORS)[number] | null) {
  const { app } = buildTestApp(env);
  const answer = who === null ? await visitor(app).get("/roles") : await as(app, who).get("/roles");
  expect(answer.status).toBe(200);
  return parse(answer.text)
    .querySelectorAll("table.roles thead th")
    .slice(1)
    .map((th) => th.text.trim());
}

describe("the table of who may do what", () => {
  it("has exactly one row and a plain name for every action", () => {
    const listed = ACTION_GROUPS.flatMap((group) => group.actions);
    expect([...listed].sort()).toEqual([...actions].sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const action of actions) expect(ACTION_WORDS[action].length, action).toBeGreaterThan(0);
    expect(rows.map((row) => row.action).sort()).toEqual([...actions].sort());
  });

  it("gives each person cell the answer of can() for its stand-in, with the owner overlay", () => {
    const others = { created_by: "someone-else", archived_at: null };
    for (const row of rows) {
      for (const role of ["customer", "team", "admin"] as Role[]) {
        const person = STAND_INS[role];
        const onOthers = can(person, row.action, others);
        const onOwn = can(person, row.action, { created_by: person.id, archived_at: null });
        const overlay = OWNER_ACTIONS[row.action];
        let expected = "No";
        if (onOthers && overlay !== undefined && role !== "customer") expected = overlay[role];
        else if (onOthers) expected = "Yes";
        else if (onOwn) expected = role === "customer" ? "Own tickets only" : "If they filed it";
        expect(row[role], `${row.action} for ${role}`).toBe(expected);
      }
    }
  });

  it("computes a customer twice, so their own tickets read Own tickets only", () => {
    const read = rows.find((row) => row.action === "read")!;
    expect(read.customer).toBe("Own tickets only");
    expect(read.team).toBe("Yes");
    const answer = rows.find((row) => row.action === "answer")!;
    expect([answer.customer, answer.team, answer.admin]).toEqual([
      "Own tickets only",
      "If they filed it",
      "If they filed it",
    ]);
  });

  it("puts an action in the owner overlay exactly when its rule names an owner", () => {
    const namesOwner = actions.filter((action) => /owner/i.test(CAPABILITIES[action].people));
    expect(Object.keys(OWNER_ACTIONS).sort()).toEqual(namesOwner.sort());
    // The overlay only narrows a Yes: each of its actions is one can() allows the team.
    const others = { created_by: "someone-else", archived_at: null };
    for (const action of namesOwner) expect(can(STAND_INS.team, action, others), action).toBe(true);
    const mark = rows.find((row) => row.action === "mark_ready")!;
    expect(mark.team).toBe("If they own it");
  });

  it("says what the ticket service allows beyond owning: an admin ends an assistant's work, a filer reopens", () => {
    const admin = STAND_INS.admin;
    const team = STAND_INS.team;
    // An admin who does not own the ticket may still end an assistant's work on it.
    const handed = { created_by: "someone-else", owner_id: "another-member", archived_at: null };
    expect(allowedActions(handed as unknown as Ticket, admin).endAgentWork).toBe(true);
    expect(rows.find((row) => row.action === "hand_to_agent")!.admin).toBe(
      "If they own it; any admin may end it",
    );
    // A team member who filed a resolved ticket may reopen it without owning it.
    const resolved = {
      created_by: team.id,
      owner_id: "another-member",
      status: "resolved",
      resolution: { by: "customer" },
      archived_at: null,
    };
    expect(allowedActions(resolved as unknown as Ticket, team).reopen).toBe(true);
    expect(rows.find((row) => row.action === "reopen")!.team).toBe("If they own it or filed it");
  });

  it("uses stand-ins that are not demo people, so the admin column reads true", () => {
    for (const person of Object.values(STAND_INS)) {
      expect(person.demo).toBeUndefined();
      expect(person.readOnly).toBeUndefined();
    }
    expect(rows.find((row) => row.action === "delete")!.admin).toBe("Yes");
  });

  it("reads Never for every people-only action, and names the scope for the rest", () => {
    for (const row of rows) {
      const needs = CAPABILITIES[row.action].agent;
      if (needs === "people_only") expect(row.assistant, row.action).toBe("Never");
      else expect(row.assistant, row.action).toBe(`With "${SCOPE_LABELS[needs]}"`);
    }
  });
});

describe("the page at /roles", () => {
  it("answers signed out, on the demo and off it, with no column marked (you)", async () => {
    for (const env of [DEMO, {}]) {
      const headers = await headersFor(env, null);
      expect(headers).toEqual(["Customer", "Team member", "Admin", "AI assistant"]);
    }
  });

  it("marks the viewer's own column for each of the demo's three people", async () => {
    const byId = (id: string) => DEMO_ACTORS.find((who) => who.id === id)!;
    expect(await headersFor(DEMO, byId("demo-customer"))).toEqual([
      "Customer (you)",
      "Team member",
      "Admin",
      "AI assistant",
    ]);
    expect(await headersFor(DEMO, byId("demo-team"))).toEqual([
      "Customer",
      "Team member (you)",
      "Admin",
      "AI assistant",
    ]);
    expect(await headersFor(DEMO, byId("demo-admin"))).toEqual([
      "Customer",
      "Team member",
      "Admin (you, read-only on this demo)",
      "AI assistant",
    ]);
  });

  it("shows the heading, the line about the check, the group rows and the owner cell", async () => {
    const { app } = buildTestApp();
    const html = parse((await as(app, teamActor).get("/roles")).text);
    expect(html.querySelectorAll("h1").map((h) => h.text)).toEqual(["Who may do what"]);
    expect(html.querySelector("main")!.text).toContain(
      "This page uses the server's own permission check and adds who must own the ticket.",
    );
    expect(html.querySelector("main")!.text).not.toContain("cannot disagree");
    // The four lines on who may say it is fixed sit under a small label, not a bold block.
    const lead = html.querySelector("h2.roles-fixed-lead")!;
    expect(lead.text).toBe("Who may say it is fixed");
    expect(lead.querySelector("strong")).toBeNull();
    expect(html.querySelectorAll("ul.roles-fixed li")).toHaveLength(4);
    expect(html.querySelector("main")!.text).toContain(
      "An assistant acts only on tickets a person has handed to it.",
    );
    expect(html.querySelectorAll("tr.roles-group th").map((th) => th.text)).toEqual([
      "The ticket",
      "Proving it is fixed",
      "Working it",
      "People and connections",
    ]);
    const mark = html.querySelector('tr[data-action="mark_ready"]')!;
    expect(mark.querySelector("th")!.text).toContain("Mark fixed and tell the customer");
    expect(mark.querySelectorAll("td").map((td) => td.text.trim())).toEqual([
      "No",
      "If they own it",
      "If they own it",
      "Never",
    ]);
  });
});

describe("the quiet ways in", () => {
  it("links to it from About this demo, People and Account", async () => {
    const { app } = buildTestApp(DEMO);
    const demoAdmin = DEMO_ACTORS.find((who) => who.readOnly === true)!;
    for (const page of ["/sign-in", "/people", "/account"]) {
      const html = parse((await as(app, demoAdmin).get(page)).text);
      expect(html.querySelector("main a[href='/roles']")?.text, page).toBe("Who may do what");
    }
  });
});
