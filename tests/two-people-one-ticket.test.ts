import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.js";
import { WRITE_LIMIT } from "../src/server/limits.js";
import {
  admin,
  as,
  buildTestApp,
  closeServers,
  customerOne,
  customerTwo,
  handToAgent,
  listenLocally,
  refusedBackToTicket,
  teamActor,
} from "./helpers.js";

// Two people acting on one ticket at once. Many races were already refused by the workflow's
// own state checks, and the first part shows them. Edits were not: two forms loaded at the same
// time both said "Changes saved", and the second quietly undid the first. A ticket now carries
// a version that rises on every change; a change sent with an older version is refused with 409
// and writes nothing, and a caller that sends no version is not checked, as before.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

async function filed(app: Express) {
  await as(app, customerOne).post("/api/tickets").send(valid);
}

const read = async (app: Express) => (await admin(app).get("/api/tickets/SUP-1")).body;

/** Someone else changes the ticket: the row is written, so its version rises. */
function changedElsewhere(db: Db) {
  db.prepare("UPDATE tickets SET updated_at = updated_at WHERE id = 1").run();
}

/** The ticket's row as stored, to show a refused change wrote nothing. */
function stored(db: Db) {
  return db.prepare("SELECT * FROM tickets WHERE id = 1").get();
}

/** The hidden version each form at this address carries, from the page as this person sees it. */
async function formVersion(app: Express, who: typeof teamActor, path: string) {
  const page = parse((await as(app, who).get(path)).text);
  return page.querySelector("input[name=expected_version]")?.getAttribute("value");
}

describe("what the workflow's state checks already refuse", () => {
  it("take against take: the second is refused, and the first owner stays", async () => {
    const { app } = buildTestApp();
    await filed(app);
    expect((await as(app, teamActor).post("/api/tickets/SUP-1/take")).status).toBe(200);
    const second = await admin(app).post("/api/tickets/SUP-1/take");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("already_owned");
    expect((await read(app)).owner_name).toBe("Team Member");
  });

  it("a hand-off after the owner sent the ticket back to New is refused", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await admin(app).patch("/api/tickets/SUP-1").send({ status: "new" });
    const handOff = await as(app, teamActor)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-admin-1", expected_owner: "dev-team-1" });
    expect(handOff.status).toBe(403);
    expect((await read(app)).status).toBe("new");
  });

  it("a status change after a hand-off is refused for the old owner", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await admin(app)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-admin-1", expected_owner: "dev-team-1" });
    const back = await as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: "new" });
    expect(back.status).toBe(403);
    expect(await read(app)).toMatchObject({ owner_name: "Admin", status: "in_progress" });
  });

  it("an answer to a question asked again is refused: it answers the old question", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const first = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({});
    await as(app, teamActor).post("/api/tickets/SUP-1/withdraw-question");
    await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({ tried: "Printed ten." });
    const answer = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: first.body.ready_token });
    expect(answer.status).toBe(409);
    expect(answer.body.error.code).toBe("question_changed");
    expect((await read(app)).status).toBe("in_progress");
  });

  it("resolve against resolve, and reopen against reopen: the second is refused", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const resolve = { reason: "wont_fix" };
    expect((await as(app, teamActor).post("/api/tickets/SUP-1/resolve").send(resolve)).status).toBe(
      200,
    );
    expect((await admin(app).post("/api/tickets/SUP-1/resolve").send(resolve)).status).toBe(409);
    const reopen = { reason: "It jams again." };
    expect((await as(app, customerOne).post("/api/tickets/SUP-1/reopen").send(reopen)).status).toBe(
      200,
    );
    const second = await as(app, teamActor).post("/api/tickets/SUP-1/reopen").send(reopen);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("not_resolved");
  });
});

describe("two people editing one ticket", () => {
  it("refuses the second save from a form loaded at the same time, and tells its editor", async () => {
    const { app } = buildTestApp();
    await filed(app);
    // Both open the edit form before either saves.
    const customersVersion = await formVersion(app, customerOne, "/tickets/SUP-1/edit");
    const teamsVersion = await formVersion(app, teamActor, "/tickets/SUP-1/edit");
    expect(customersVersion).toBe("1");
    expect(teamsVersion).toBe("1");

    const first = await as(app, customerOne)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ ...valid, title: "Printer jams on page two", expected_version: customersVersion });
    expect(first.status).toBe(303);

    const second = await as(app, teamActor)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({
        ...valid,
        description: "Jams on every second page.",
        expected_version: teamsVersion,
      });
    expect(second.status).toBe(409);
    // Nothing was written over the first save.
    expect(await read(app)).toMatchObject({
      title: "Printer jams on page two",
      description: "It jams on page two.",
    });
    // The form comes back with what was typed, one plain line, a link to the current ticket and
    // the newer version.
    const form = parse(second.text);
    expect(form.querySelector("p.changed-elsewhere")?.text).toContain(
      "Someone changed this ticket while you were editing. Your text is kept below: compare it with the current ticket, then save again.",
    );
    const link = form.querySelector("p.changed-elsewhere a");
    expect(link?.getAttribute("href")).toBe("/tickets/SUP-1");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(form.querySelector("textarea[name=description]")?.text).toBe(
      "Jams on every second page.",
    );
    const fresh = form.querySelector("input[name=expected_version]")?.getAttribute("value");
    expect(fresh).toBe(String((await read(app)).version));
    // The team member's locked box still shows the customer's own check.
    expect(form.querySelector("textarea[readonly]")?.text).toBe("Ten pages print");

    // Saving again, deliberately, from that form goes through.
    const again = await as(app, teamActor).post("/tickets/SUP-1/edit").type("form").send({
      title: "Printer jams on page two",
      description: "Jams on every second page.",
      expected_version: fresh,
    });
    expect(again.status).toBe(303);
    expect((await read(app)).description).toBe("Jams on every second page.");
  });

  it("refuses an API edit sent with an old version, and writes nothing", async () => {
    const { app, db } = buildTestApp();
    await filed(app);
    const seen = (await read(app)).version;
    await as(app, customerOne)
      .put("/api/tickets/SUP-1")
      .send({ ...valid, title: "First save" });
    const before = stored(db);
    const res = await admin(app)
      .put("/api/tickets/SUP-1")
      .send({ ...valid, title: "Second save", expected_version: seen });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ticket_changed");
    expect(res.body.error.message).toBe(
      "Ticket SUP-1 changed since you opened it, so nothing was saved. This is the ticket as it is now.",
    );
    expect(stored(db)).toEqual(before);
  });

  it("checks nothing for a caller that sends no version, as before", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, customerOne)
      .put("/api/tickets/SUP-1")
      .send({ ...valid, title: "First save" });
    const res = await admin(app)
      .put("/api/tickets/SUP-1")
      .send({ ...valid, title: "Second save" });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Second save");
  });
});

type Case = {
  name: string;
  /** Puts the ticket where the action can be taken. */
  setup: (app: Express) => Promise<unknown>;
  /** Sends the action, with this version in the body. */
  send: (
    app: Express,
    version: number,
  ) => Promise<{ status: number; body: { error?: { code?: string } } }>;
};

const takeAndStart = (app: Express) => as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
const asked = async (app: Express) => {
  await takeAndStart(app);
  await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({});
};
const none = async () => undefined;

const CASES: Case[] = [
  {
    name: "edit_ticket",
    setup: none,
    send: (app, v) =>
      as(app, customerOne)
        .put("/api/tickets/SUP-1")
        .send({ ...valid, title: "New title", expected_version: v }),
  },
  {
    name: "change_status",
    setup: (app) => as(app, teamActor).post("/api/tickets/SUP-1/take"),
    send: (app, v) =>
      as(app, teamActor)
        .patch("/api/tickets/SUP-1")
        .send({ status: "in_progress", expected_version: v }),
  },
  {
    name: "take_ticket",
    setup: none,
    send: (app, v) =>
      as(app, teamActor).post("/api/tickets/SUP-1/take").send({ expected_version: v }),
  },
  {
    name: "take_and_start",
    setup: none,
    send: (app, v) =>
      as(app, teamActor).post("/api/tickets/SUP-1/take-and-start").send({ expected_version: v }),
  },
  {
    name: "release_ticket",
    setup: (app) => as(app, teamActor).post("/api/tickets/SUP-1/take"),
    send: (app, v) =>
      as(app, teamActor).post("/api/tickets/SUP-1/release").send({ expected_version: v }),
  },
  {
    name: "hand_off",
    setup: takeAndStart,
    send: (app, v) =>
      as(app, teamActor)
        .post("/api/tickets/SUP-1/hand-off")
        .send({ to: "dev-admin-1", expected_owner: "dev-team-1", expected_version: v }),
  },
  {
    name: "agree_check",
    setup: none,
    send: (app, v) =>
      as(app, teamActor)
        .put("/api/tickets/SUP-1/agreed-check")
        .send({ agreed_check: "Ten pages print without a jam", expected_version: v }),
  },
  {
    name: "adopt_check",
    setup: (app) =>
      as(app, teamActor)
        .put("/api/tickets/SUP-1/agreed-check")
        .send({ agreed_check: "Ten pages print without a jam" }),
    send: (app, v) =>
      as(app, customerOne).post("/api/tickets/SUP-1/adopt-check").send({ expected_version: v }),
  },
  {
    name: "link_change",
    setup: none,
    send: (app, v) =>
      as(app, teamActor)
        .put("/api/tickets/SUP-1/change-link")
        .send({ change_url: "https://example.com/change/1", expected_version: v }),
  },
  {
    name: "mark_ready",
    setup: takeAndStart,
    send: (app, v) =>
      as(app, teamActor).post("/api/tickets/SUP-1/ready").send({ expected_version: v }),
  },
  {
    name: "withdraw_question",
    setup: asked,
    send: (app, v) =>
      as(app, teamActor).post("/api/tickets/SUP-1/withdraw-question").send({ expected_version: v }),
  },
  {
    name: "resolve_with_reason",
    setup: none,
    send: (app, v) =>
      as(app, teamActor)
        .post("/api/tickets/SUP-1/resolve")
        .send({ reason: "wont_fix", expected_version: v }),
  },
  {
    name: "reopen",
    setup: (app) =>
      as(app, teamActor).post("/api/tickets/SUP-1/resolve").send({ reason: "wont_fix" }),
    send: (app, v) =>
      as(app, customerOne)
        .post("/api/tickets/SUP-1/reopen")
        .send({ reason: "It jams again.", expected_version: v }),
  },
  {
    name: "give_to_agent",
    setup: takeAndStart,
    send: async (app, v) => {
      const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
      const id = page.querySelector("select[name=connection_id] option")?.getAttribute("value");
      return as(app, teamActor)
        .post("/api/tickets/SUP-1/agent")
        .send({ connection_id: id, expected_version: v });
    },
  },
  {
    name: "end_agent_work",
    setup: async (app) => handToAgent(app, "SUP-1", await issueKey(app)),
    send: (app, v) => admin(app).post("/api/tickets/SUP-1/agent/end").send({ expected_version: v }),
  },
];

/** Issues an assistant connection and returns its key. */
async function issueKey(app: Express, scopes = ["read_tickets", "write_notes"]) {
  const res = await admin(app).post("/connections").type("form").send({ name: "Helper", scopes });
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
}

describe("every action that accepts a version", () => {
  it.each(CASES)("$name refuses an old version and accepts the current one", async (c) => {
    const { app, db } = buildTestApp();
    await filed(app);
    // A connection exists for the hand to an assistant, whatever the case.
    if (c.name === "give_to_agent") await issueKey(app);
    await c.setup(app);
    const seen = (await read(app)).version;
    changedElsewhere(db);
    const before = stored(db);
    const old = await c.send(app, seen);
    expect(old.status).toBe(409);
    expect(old.body.error?.code).toBe("ticket_changed");
    expect(stored(db)).toEqual(before);

    const current = (await read(app)).version;
    const res = await c.send(app, current);
    expect(res.status).toBe(200);
    expect((await read(app)).version).toBeGreaterThan(current);
  });

  it("is described in the API's own description, with the version in the ticket's JSON", async () => {
    const { app } = buildTestApp();
    const spec = (await admin(app).get("/api/openapi.json")).body;
    const bodyOf = (path: string, method: string) =>
      spec.paths[path][method].requestBody.content["application/json"].schema;
    const fields = (schema: { properties?: object; $ref?: string }) =>
      Object.keys(
        schema.properties ?? spec.components.schemas[schema.$ref!.split("/").pop()!].properties,
      );
    expect(fields(bodyOf("/tickets/{key}", "put"))).toContain("expected_version");
    expect(fields(bodyOf("/tickets/{key}/take", "post"))).toContain("expected_version");
    expect(fields(bodyOf("/tickets/{key}/resolve", "post"))).toContain("expected_version");
    expect(spec.components.schemas.Ticket.properties.version).toBeDefined();
  });
});

const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await closeServers(servers);
});

describe("an assistant's tools", () => {
  it("take the version too, and refuse an old one", async () => {
    const { app, db } = buildTestApp();
    await filed(app);
    const key = await issueKey(app, ["read_tickets", "link_changes"]);
    await handToAgent(app, "SUP-1", key);
    const server = await listenLocally(app);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const client = new Client({ name: "test-assistant", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    const tool = (await client.listTools()).tools.find((t) => t.name === "link_change");
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toContain("expected_version");

    const seen = (await read(app)).version;
    changedElsewhere(db);
    const result = await client.callTool({
      name: "link_change",
      arguments: { key: "SUP-1", change_url: "https://example.com/c/2", expected_version: seen },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("ticket_changed");
    expect((await read(app)).change_url).toBeNull();
  });
});

describe("the version", () => {
  it("rises on every kind of change, an assistant's included", async () => {
    const { app } = buildTestApp();
    await filed(app);
    const versions = [(await read(app)).version];
    const step = async (change: () => Promise<unknown>) => {
      await change();
      versions.push((await read(app)).version);
    };
    const key = await issueKey(app, ["read_tickets", "write_notes", "link_changes"]);
    const agent = (path: string) => request(app).put(path).set("Authorization", `Bearer ${key}`);
    await step(() =>
      as(app, customerOne)
        .put("/api/tickets/SUP-1")
        .send({ ...valid, title: "Edited" }),
    );
    await step(() => as(app, teamActor).post("/api/tickets/SUP-1/take"));
    await step(() =>
      as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: "in_progress" }),
    );
    await step(() =>
      as(app, teamActor)
        .put("/api/tickets/SUP-1/agreed-check")
        .send({ agreed_check: "Ten pages print without a jam" }),
    );
    await step(() => handToAgent(app, "SUP-1", key));
    // The assistant links the change it made.
    await step(() =>
      agent("/api/tickets/SUP-1/change-link").send({ change_url: "https://example.com/c/1" }),
    );
    await step(() => as(app, teamActor).post("/api/tickets/SUP-1/ready").send({}));
    await step(() => as(app, teamActor).post("/api/tickets/SUP-1/withdraw-question"));
    await step(() =>
      as(app, teamActor)
        .post("/api/tickets/SUP-1/hand-off")
        .send({ to: "dev-admin-1", expected_owner: "dev-team-1" }),
    );
    await step(() => admin(app).post("/api/tickets/SUP-1/resolve").send({ reason: "wont_fix" }));
    await step(() =>
      as(app, customerOne).post("/api/tickets/SUP-1/reopen").send({ reason: "Again." }),
    );
    await step(() => admin(app).post("/api/tickets/SUP-1/archive"));
    await step(() => admin(app).post("/api/tickets/SUP-1/restore"));
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i], `step ${i}`).toBeGreaterThan(versions[i - 1]!);
    }
  });

  it("does not rise when a change asked for changes nothing", async () => {
    const { app } = buildTestApp();
    await filed(app);
    const before = (await read(app)).version;
    const res = await as(app, customerOne).put("/api/tickets/SUP-1").send(valid);
    expect(res.body.version).toBe(before);
  });

  it("comes back with the change, as the version saved", async () => {
    const { app } = buildTestApp();
    await filed(app);
    const res = await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    expect(res.body.version).toBe((await read(app)).version);
    expect(res.body.version).toBeGreaterThan(1);
  });
});

describe("the ticket page's own forms", () => {
  it("each send the version the page shows", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const version = String((await read(app)).version);
    const changing = [
      "/status",
      "/resolve",
      "/ready",
      "/hand-off",
      "/agreed-check",
      "/change-link",
    ];
    for (const ending of changing) {
      const forms = page
        .querySelectorAll("form")
        .filter((form) => form.getAttribute("action") === `/tickets/SUP-1${ending}`);
      expect(forms.length, ending).toBeGreaterThan(0);
      for (const form of forms) {
        expect(
          form.querySelector("input[name=expected_version]")?.getAttribute("value"),
          ending,
        ).toBe(version);
      }
    }
  });

  it("refuse a press from a page left open after the ticket changed, and show the ticket now", async () => {
    const { app, db } = buildTestApp();
    await filed(app);
    const version = await formVersion(app, teamActor, "/tickets/SUP-1");
    changedElsewhere(db);
    const reason = await refusedBackToTicket(as(app, teamActor), "/tickets/SUP-1/take-and-start", {
      expected_version: version!,
    });
    expect(reason).toBe(
      "Ticket SUP-1 changed since you opened it, so nothing was saved. This is the ticket as it is now.",
    );
    expect((await read(app)).owner_id).toBeNull();
  });
});

describe("the cheap read a page left open asks", () => {
  it("gives the version and the entries this viewer sees, notes left out for a customer", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/entries").send({ kind: "reply", body: "Hi" });
    await as(app, teamActor).post("/api/tickets/SUP-1/entries").send({ kind: "note", body: "x" });
    const version = (await read(app)).version;
    expect((await as(app, customerOne).get("/tickets/SUP-1/version")).body).toEqual({
      version,
      entries: 1,
    });
    expect((await as(app, teamActor).get("/tickets/SUP-1/version")).body).toEqual({
      version,
      entries: 2,
    });
  });

  it("tells another customer nothing about a ticket that is not theirs", async () => {
    const { app } = buildTestApp();
    await filed(app);
    const res = await as(app, customerTwo).get("/tickets/SUP-1/version");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('"version"');
    expect((await as(app, customerTwo).get("/tickets/SUP-2/version")).status).toBe(404);
  });

  it("does not count against the write limit, and leaves the page's saved message alone", async () => {
    const { app } = buildTestApp();
    await filed(app);
    const team = as(app, teamActor);
    for (let i = 0; i <= WRITE_LIMIT; i++) {
      expect((await team.get("/tickets/SUP-1/version")).status).toBe(200);
    }
    const take = await team.post("/tickets/SUP-1/take").type("form").send({});
    expect(take.status).toBe(303);
    await team.get("/tickets/SUP-1/version");
    expect((await team.get("/tickets/SUP-1")).text).toContain("You own this ticket now.");
  });

  it("matches what the ticket page draws, so an unchanged page stays quiet", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "Hi" });
    const page = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    const layout = page.querySelector("[data-ticket-version]")!;
    const stamp = (await as(app, customerOne).get("/tickets/SUP-1/version")).body;
    expect(layout.getAttribute("data-ticket-key")).toBe("SUP-1");
    expect(Number(layout.getAttribute("data-ticket-version"))).toBe(stamp.version);
    expect(Number(layout.getAttribute("data-ticket-entries"))).toBe(stamp.entries);
  });
});
