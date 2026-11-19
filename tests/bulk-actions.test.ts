import { parse } from "node-html-parser";
import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { DEV_COOKIE, type Actor } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { LIST_PAGE_SIZE } from "../src/server/tickets/types.js";
import { admin, adminActor, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// The ticket list changes tickets in place: the team ticks rows, then sets one status or one
// owner for all of them. Each ticket goes through the same rules as on its own page, so the
// list's answer says what moved and why each other ticket did not.

const ticket = (title: string) => ({ title, description: "x", fix_check: "It works" });

/** Files these tickets as the customer, SUP-1 onwards. */
async function file(app: Express, titles: string[]) {
  for (const title of titles) {
    const res = await as(app, customerOne).post("/api/tickets").send(ticket(title));
    expect(res.status).toBe(201);
  }
}

/** Posts the list's form as a browser would, with no script: the boxes and the bar together. */
function postForm(app: Express, who: Actor, query: string, fields: Record<string, unknown>) {
  return as(app, who).post(`/tickets/bulk${query}`).type("form").send(fields);
}

/** The list page this browser opens next, carrying the cookies the form's answer set. */
async function listAfter(app: Express, who: Actor, posted: request.Response) {
  const cookies = [posted.headers["set-cookie"]].flat().filter((c): c is string => !!c);
  const res = await visitor(app)
    .get(posted.headers.location as string)
    .set("Cookie", [`${DEV_COOKIE}=${who.id}`, ...cookies.map((c) => c.split(";")[0]!)]);
  return parse(res.text);
}

const savedLine = (page: ReturnType<typeof parse>) =>
  page.querySelector('p[role="status"].saved')?.text ?? null;

async function eventTypes(app: Express, key: string): Promise<string[]> {
  const events = (await admin(app).get(`/api/tickets/${key}/events`)).body as { type: string }[];
  return events.map((event) => event.type);
}

describe("changing ticked tickets from the list", () => {
  it("lets a team member search, tick every row shown and resolve them with one reason", async () => {
    const { app } = buildTestApp();
    await file(app, ["Export is empty", "Printer jams", "Export times out"]);
    const list = parse((await as(app, teamActor).get("/tickets?q=export")).text);
    const keys = list
      .querySelectorAll('form[data-bulk] input[name="keys"]')
      .map((box) => box.getAttribute("value"));
    expect(keys.sort()).toEqual(["SUP-1", "SUP-3"]);
    // The form posts back to the same view of the list.
    expect(list.querySelector("form[data-bulk]")?.getAttribute("action")).toBe(
      "/tickets/bulk?q=export",
    );

    const posted = await postForm(app, teamActor, "?q=export", {
      keys,
      apply: "status",
      status: "resolved",
      reason: "wont_fix",
      owner: "",
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.location).toBe("/tickets?q=export");
    expect(savedLine(await listAfter(app, teamActor, posted))).toBe("2 moved to Resolved.");

    for (const key of ["SUP-1", "SUP-3"]) {
      const resolved = (await admin(app).get(`/api/tickets/${key}`)).body;
      expect(resolved).toMatchObject({ status: "resolved", owner_name: "Team Member" });
      expect(resolved.resolution).toMatchObject({ by: "team", reason: "wont_fix" });
      // Each ticket has its own history: the same entries as resolving it on its own page.
      expect((await eventTypes(app, key)).slice(-2)).toEqual(["owner_changed", "resolved_by_team"]);
    }
    expect((await admin(app).get("/api/tickets/SUP-2")).body.status).toBe("new");
  });

  it("reports each ticket it did not change, and changes nothing it refused", async () => {
    const { app } = buildTestApp();
    await file(app, ["One", "Two", "Three"]);
    // SUP-2 belongs to the admin; SUP-3 is already resolved, by the team member.
    await admin(app).post("/api/tickets/SUP-2/take");
    await as(app, teamActor)
      .post("/api/tickets/SUP-3/resolve")
      .send({ reason: "cannot_reproduce" });
    const before = {
      two: await admin(app).get("/api/tickets/SUP-2"),
      three: await admin(app).get("/api/tickets/SUP-3"),
    };

    const posted = await postForm(app, teamActor, "", {
      keys: ["SUP-1", "SUP-2", "SUP-3"],
      apply: "status",
      status: "resolved",
      reason: "duplicate",
      duplicate_of: "SUP-9",
    });
    // SUP-9 does not exist, so the duplicate reason fits none of them, and nothing moves.
    expect(savedLine(await listAfter(app, teamActor, posted))).toBe(
      "3 were not changed: SUP-1 (that reason does not fit it); SUP-2 (only its owner or an admin can resolve it); SUP-3 (already resolved).",
    );

    const again = await postForm(app, teamActor, "", {
      keys: ["SUP-1", "SUP-2", "SUP-3"],
      apply: "status",
      status: "resolved",
      reason: "wont_fix",
    });
    expect(savedLine(await listAfter(app, teamActor, again))).toBe(
      "1 moved to Resolved. 2 were not changed: SUP-2 (only its owner or an admin can resolve it); SUP-3 (already resolved).",
    );
    expect((await admin(app).get("/api/tickets/SUP-2")).body).toEqual(before.two.body);
    expect((await admin(app).get("/api/tickets/SUP-3")).body).toEqual(before.three.body);
  });

  it("assigns ticked tickets, through take, hand-off and release", async () => {
    const { app } = buildTestApp();
    await file(app, ["One", "Two", "Three"]);
    await admin(app).post("/api/tickets/SUP-3/take-and-start");

    const mine = await postForm(app, teamActor, "", {
      keys: ["SUP-1", "SUP-2"],
      apply: "owner",
      owner: "me",
      status: "resolved",
    });
    expect(savedLine(await listAfter(app, teamActor, mine))).toBe("2 assigned to you.");
    expect((await eventTypes(app, "SUP-1")).at(-1)).toBe("owner_changed");

    // The admin hands one to the team member by name, and SUP-3, in progress, keeps its owner.
    const named = await postForm(app, adminActor, "", {
      keys: ["SUP-3"],
      apply: "owner",
      owner: teamActor.id,
    });
    expect(savedLine(await listAfter(app, adminActor, named))).toBe("1 assigned to Team Member.");

    const nobody = await postForm(app, teamActor, "", {
      keys: ["SUP-1", "SUP-3"],
      apply: "owner",
      owner: "nobody",
    });
    expect(savedLine(await listAfter(app, teamActor, nobody))).toBe(
      "1 now has no owner. 1 was not changed: SUP-3 (in progress, so it keeps an owner).",
    );
    expect((await admin(app).get("/api/tickets/SUP-1")).body.owner_id).toBeNull();
    expect((await admin(app).get("/api/tickets/SUP-3")).body.owner_id).toBe(teamActor.id);
  });

  it("starts work and sends it back to New by the ticket's own steps", async () => {
    const { app } = buildTestApp();
    await file(app, ["One", "Two"]);
    await admin(app).post("/api/tickets/SUP-2/take");
    const started = await admin(app)
      .post("/api/tickets/bulk")
      .send({ keys: ["SUP-1", "SUP-2"], status: "in_progress" });
    expect(started.status).toBe(200);
    // SUP-1 had no owner, so the team member takes and starts it; SUP-2 is the admin's to start.
    expect(started.body).toEqual({
      change: { status: "in_progress" },
      changed: ["SUP-1", "SUP-2"],
      not_changed: [],
    });
    const back = await as(app, teamActor)
      .post("/api/tickets/bulk")
      .send({ keys: ["SUP-1", "SUP-2", "SUP-404"], status: "new" });
    expect(back.body.changed).toEqual([]);
    expect(back.body.not_changed).toEqual([
      expect.objectContaining({ key: "SUP-1", status: 403, code: "not_owner" }),
      expect.objectContaining({ key: "SUP-2", status: 403, code: "not_owner" }),
      { key: "SUP-404", status: 404, code: "ticket_not_found", message: "No ticket SUP-404." },
    ]);
    const already = await admin(app)
      .post("/api/tickets/bulk")
      .send({ keys: ["SUP-1"], status: "in_progress" });
    expect(already.body.not_changed).toEqual([
      {
        key: "SUP-1",
        status: 200,
        code: "nothing_to_change",
        message: "SUP-1 is In Progress already.",
      },
    ]);
  });

  it("keeps the boxes ticked and says what is missing when the form is incomplete", async () => {
    const { app } = buildTestApp();
    await file(app, ["One", "Two"]);
    const res = await postForm(app, teamActor, "", {
      keys: "SUP-2",
      apply: "status",
      status: "resolved",
      reason: "",
    });
    expect(res.status).toBe(400);
    const page = parse(res.text);
    expect(page.querySelector(".bulk-error")?.text).toBe("Choose a reason.");
    expect(page.querySelector('input[value="SUP-2"]')?.hasAttribute("checked")).toBe(true);
    expect(page.querySelector('input[value="SUP-1"]')?.hasAttribute("checked")).toBe(false);
    expect((await admin(app).get("/api/tickets/SUP-2")).body.status).toBe("new");

    const none = await postForm(app, teamActor, "", { apply: "owner", owner: "me" });
    expect(parse(none.text).querySelector(".bulk-error")?.text).toBe("Tick at least one ticket.");
  });

  it("drops a note left in the form unless the reason is Other", async () => {
    const { app } = buildTestApp();
    await file(app, ["One"]);
    const posted = await postForm(app, teamActor, "", {
      keys: "SUP-1",
      apply: "status",
      status: "resolved",
      reason: "wont_fix",
      note: "typed before the reason changed",
    });
    expect(posted.status).toBe(303);
    const resolved = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(resolved.resolution).toMatchObject({ by: "team", reason: "wont_fix", note: null });
  });

  it("changes a ticket once when its key is sent in two letter cases", async () => {
    const { app } = buildTestApp();
    await file(app, ["One"]);
    const res = await admin(app)
      .post("/api/tickets/bulk")
      .send({ keys: ["sup-1", "SUP-1"], owner: "me" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ change: { owner: "me" }, changed: ["SUP-1"], not_changed: [] });
  });

  it("explains a key that is not a ticket key as no such ticket", async () => {
    const { app } = buildTestApp();
    await file(app, ["One"]);
    const posted = await postForm(app, teamActor, "", {
      keys: ["nope", "SUP-1"],
      apply: "owner",
      owner: "me",
    });
    expect(savedLine(await listAfter(app, teamActor, posted))).toBe(
      "1 assigned to you. 1 was not changed: NOPE (no such ticket).",
    );
  });

  it("changes at most one page of the list in one request", async () => {
    const { app } = buildTestApp();
    const keys = Array.from({ length: LIST_PAGE_SIZE + 1 }, (_, i) => `SUP-${i + 1}`);
    const res = await admin(app).post("/api/tickets/bulk").send({ keys, owner: "me" });
    expect(res.status).toBe(400);
  });
});

describe("who may change tickets from the list", () => {
  it("shows tick boxes to the team, and none to a customer", async () => {
    const { app } = buildTestApp();
    await file(app, ["One"]);
    const team = parse((await as(app, teamActor).get("/tickets")).text);
    expect(team.querySelectorAll('input[name="keys"]')).toHaveLength(1);
    expect(team.querySelector("[data-bulk-bar]")?.text).toContain("Assign to");
    const customer = parse((await as(app, customerOne).get("/tickets")).text);
    expect(customer.querySelector("form[data-bulk]")).toBeNull();
    expect(customer.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it("refuses a customer, and changes nothing", async () => {
    const { app } = buildTestApp();
    await file(app, ["One"]);
    const res = await postForm(app, customerOne, "", {
      keys: "SUP-1",
      apply: "status",
      status: "resolved",
      reason: "wont_fix",
    });
    expect(res.status).toBe(403);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("new");
  });

  it("shows the read-only preview no boxes and refuses its post", async () => {
    const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(db, config.ticketPrefix));
    const preview = () => visitor(app).set("Cookie", `${DEV_COOKIE}=demo-admin`);
    const page = parse((await preview().get("/tickets")).text);
    expect(page.querySelector("form[data-bulk]")).toBeNull();
    const before = (await preview().get("/api/tickets/SUP-1")).body;
    const res = await preview()
      .post("/tickets/bulk")
      .type("form")
      .send({ keys: "SUP-1", apply: "owner", owner: "me" });
    expect(res.status).toBe(403);
    expect((await preview().get("/api/tickets/SUP-1")).body).toEqual(before);
  });

  it("refuses an assistant key holding every scope", async () => {
    const { app } = buildTestApp();
    await file(app, ["One"]);
    const issued = await admin(app)
      .post("/connections")
      .type("form")
      .send({
        name: "Helper",
        scopes: [
          "read_tickets",
          "read_notes",
          "write_notes",
          "attach_evidence",
          "propose_specs",
          "link_changes",
        ],
      });
    const res = await request(app)
      .post("/api/tickets/bulk")
      .set("Authorization", `Bearer ${keyOnPage(issued.text)}`)
      .send({ keys: ["SUP-1"], owner: "nobody" });
    expect(res.status).toBe(403);
  });

  it("refuses a post from another site", async () => {
    const { app } = buildTestApp();
    await file(app, ["One"]);
    const res = await request(app)
      .post("/tickets/bulk")
      .set("Cookie", `${DEV_COOKIE}=${teamActor.id}`)
      .set("Sec-Fetch-Site", "cross-site")
      .type("form")
      .send({ keys: "SUP-1", apply: "owner", owner: "me" });
    expect(res.status).toBe(403);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.owner_id).toBeNull();
  });
});
