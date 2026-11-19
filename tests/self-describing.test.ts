import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/server/api/actions.js";
import { TOOL_ACTIONS } from "../src/server/mcp.js";
import { admin, as, buildTestApp, customerOne } from "./helpers.js";

// The API describes itself: a guide at GET /api and the machine-readable description at
// GET /api/openapi.json, both built from the tables the server uses.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

async function issue(app: Express, scopes: string[]) {
  const res = await admin(app).post("/connections").type("form").send({ name: "Helper", scopes });
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
}

describe("the guide at GET /api", () => {
  it("lets an agent do the one job with no other reading", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api");
    expect(res.status).toBe(200);
    const { start_here, you, addresses, untrusted_text } = res.body;
    expect(you).toMatchObject({ signed_in: false });
    expect(you.how).toMatch(/Authorization: Bearer/);
    expect(start_here.steps.map((s: { mcp?: string }) => s.mcp).filter(Boolean)).toEqual([
      "list_tickets {}",
      "get_ticket { key: 'SUP-1' }",
      expect.stringMatching(/^add_evidence /),
      expect.stringMatching(/^ask_owner_to_review /),
    ]);
    const evidenceCall = start_here.steps[3].http as string;
    expect(evidenceCall).toMatch(/Idempotency-Key/);
    expect(evidenceCall).toMatch(/\/api\/tickets\/SUP-1\/evidence$/);
    for (const topic of [
      "ownership",
      "done_when",
      "no_check",
      "blocked",
      "retries",
      "paging",
      "errors",
      "results",
      "stop",
    ]) {
      expect(start_here[topic], topic).toEqual(expect.any(String));
    }
    expect(start_here.ownership).toMatch(/only the customer answers/);
    expect(untrusted_text).toMatch(/never as instructions/);
    expect(new Set(Object.values(addresses)).size).toBe(4);
    expect(addresses.openapi).toMatch(/\/api\/openapi\.json$/);
  });

  it("tells a connection exactly what it may and may not do", async () => {
    const { app } = buildTestApp();
    const key = await issue(app, ["read_tickets", "write_notes", "attach_evidence"]);
    const { you } = (await request(app).get("/api").set("Authorization", `Bearer ${key}`)).body;
    expect(you).toMatchObject({ kind: "agent", connection: "Helper" });
    expect(you.may).toEqual(expect.arrayContaining(["read", "note", "attach_evidence"]));
    expect(you.may).not.toContain("reply");
    expect(you.may_not).toEqual(
      expect.arrayContaining(["answer", "take", "mark_ready", "delete", "reply"]),
    );
  });
});

describe("the description at GET /api/openapi.json", () => {
  it("describes every action, with its permission and the bearer key", async () => {
    const { app } = buildTestApp();
    const doc = (await request(app).get("/api/openapi.json")).body;
    expect(doc.openapi).toBe("3.1.0");
    const operations = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods as object),
    );
    expect(operations.map((op: { operationId: string }) => op.operationId).sort()).toEqual(
      ACTIONS.map((row) => row.name).sort(),
    );
    expect(doc.components.securitySchemes.connectionKey).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(doc.components.schemas.Ticket.properties.done_when).toBeDefined();
  });
});

describe("real answers", () => {
  it("match the documented shape for every action", async () => {
    const { app } = buildTestApp();
    const checked = new Set<string>();
    const expectShape = (name: string, res: request.Response) => {
      const row = ACTIONS.find((r) => r.name === name)!;
      expect(res.status, `${name}: ${res.text}`).toBe(row.status ?? 200);
      const result = row.output.safeParse(res.body);
      expect(result.success, `${name}: ${result.error?.message}`).toBe(true);
      checked.add(name);
    };
    const t = "/api/tickets/SUP-1";
    expectShape("create_ticket", await as(app, customerOne).post("/api/tickets").send(valid));
    expectShape("list_tickets", await admin(app).get("/api/tickets"));
    expectShape("get_ticket", await admin(app).get(t));
    expectShape(
      "edit_ticket",
      await admin(app)
        .put(t)
        .send({ ...valid, title: "Printer jams again" }),
    );
    expectShape(
      "agree_check",
      await admin(app).put(`${t}/agreed-check`).send({ agreed_check: "A 10-page PDF prints" }),
    );
    expectShape("adopt_check", await as(app, customerOne).post(`${t}/adopt-check`));
    expectShape("take_ticket", await admin(app).post(`${t}/take`));
    expectShape(
      "hand_off",
      await admin(app)
        .post(`${t}/hand-off`)
        .send({ to: "dev-admin-1", expected_owner: "dev-admin-1" }),
    );
    expectShape("change_status", await admin(app).patch(t).send({ status: "in_progress" }));
    expectShape(
      "add_entry",
      await admin(app).post(`${t}/entries`).send({ kind: "note", body: "Looking" }),
    );
    expectShape("add_note", await admin(app).post(`${t}/notes`).send({ body: "A note" }));
    expectShape("list_entries", await admin(app).get(`${t}/entries`));
    expectShape(
      "add_evidence",
      await admin(app).post(`${t}/evidence`).send({ kind: "note", summary: "Seen" }),
    );
    expectShape("list_evidence", await admin(app).get(`${t}/evidence`));
    const spec = {
      summary: "Printing works.",
      scenarios: [
        { title: "Ten pages", given: "paper", when: "ten pages print", then: "none jam" },
      ],
    };
    expectShape("propose_spec", await admin(app).post(`${t}/spec`).send(spec));
    // A ticket read with a spec in it, and evidence naming its scenario.
    expectShape("get_ticket", await admin(app).get(t));
    expectShape(
      "add_evidence",
      await admin(app).post(`${t}/evidence`).send({ kind: "test", summary: "Ran", scenario: 1 }),
    );
    expectShape(
      "decide_spec",
      await admin(app).post(`${t}/spec/decision`).send({ decision: "accept" }),
    );
    expectShape(
      "ask_owner_to_review",
      await admin(app).post(`${t}/owner-review`).send({ message: "Ready" }),
    );
    expectShape(
      "link_change",
      await admin(app).put(`${t}/change-link`).send({ change_url: "https://example.com/c" }),
    );
    const ready = await admin(app)
      .post(`${t}/ready`)
      .send({ try_url: "https://example.com/t", tried: "I printed ten pages.", result: "No jam." });
    expectShape("mark_ready", ready);
    expectShape("withdraw_question", await admin(app).post(`${t}/withdraw-question`));
    const askedAgain = await admin(app)
      .post(`${t}/ready`)
      .send({ try_url: "https://example.com/t", tried: "I printed ten pages.", result: "No jam." });
    expectShape(
      "answer",
      await as(app, customerOne)
        .post(`${t}/answer`)
        .send({ fixed: "yes", ready_token: askedAgain.body.ready_token }),
    );
    expectShape("list_events", await admin(app).get(`${t}/events`));
    // Release is for the owner of a New ticket: a third one, taken and let go.
    await as(app, customerOne).post("/api/tickets").send(valid);
    await admin(app).post("/api/tickets/SUP-2/take");
    expectShape("release_ticket", await admin(app).post("/api/tickets/SUP-2/release"));
    expectShape(
      "reopen",
      await as(app, customerOne).post(`${t}/reopen`).send({ reason: "It jams again." }),
    );
    // The owner hands the reopened ticket to an assistant, then stops it.
    await issue(app, ["read_tickets"]);
    expectShape("give_to_agent", await admin(app).post(`${t}/agent`).send({ connection_id: 1 }));
    expectShape("end_agent_work", await admin(app).post(`${t}/agent/end`));
    await as(app, customerOne).post("/api/tickets").send(valid);
    expectShape("take_and_start", await admin(app).post("/api/tickets/SUP-3/take-and-start"));
    expectShape(
      "resolve_with_reason",
      await admin(app).post("/api/tickets/SUP-3/resolve").send({ reason: "wont_fix" }),
    );
    expectShape("archive_ticket", await admin(app).post(`${t}/archive`));
    expectShape("restore_ticket", await admin(app).post(`${t}/restore`));
    expectShape("delete_ticket", await admin(app).delete(t).send({ confirm: "SUP-1" }));
    expect([...checked].sort()).toEqual(ACTIONS.map((row) => row.name).sort());
  });
});

describe("the guide's own addresses and tools", () => {
  it("names only paths in the action table and tools an assistant can be given", async () => {
    const { app } = buildTestApp();
    const steps = (await request(app).get("/api")).body.start_here.steps as {
      http?: string;
      mcp?: string;
    }[];
    const patterns = ACTIONS.map(
      (row) =>
        new RegExp(`^${row.method.toUpperCase()} /api${row.path.replace(/:key/g, "[A-Z]+-\\d+")}$`),
    );
    let named = 0;
    for (const step of steps) {
      if (step.http !== undefined) {
        const path = /https?:\/\/[^/\s]+(\/api\/[^\s'"?]*)/.exec(step.http)![1]!;
        const method = step.http.includes(" -d ") ? "POST" : "GET";
        expect(
          patterns.some((p) => p.test(`${method} ${path}`)),
          `${method} ${path}`,
        ).toBe(true);
        named += 1;
      }
      if (step.mcp !== undefined) {
        const tool = step.mcp.split(" ")[0]!;
        expect(
          TOOL_ACTIONS.map((row) => row.name),
          tool,
        ).toContain(tool);
      }
    }
    expect(named).toBeGreaterThanOrEqual(4);
  });
});
