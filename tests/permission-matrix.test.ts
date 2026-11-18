import fs from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { parse } from "node-html-parser";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_COOKIE, type Actor } from "../src/server/actor.js";
import { ACTIONS } from "../src/server/api/actions.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase, type Db } from "../src/server/db.js";
import {
  adminActor,
  as,
  buildTestApp,
  closeServers,
  customerOne,
  customerTwo,
  FROM_THIS_SITE,
  listenLocally,
  teamActor,
} from "./helpers.js";

// Who may do what, in every ticket state: one table, written by hand from the rules in
// docs/SPEC.md and the README, not from src/server/permissions.ts, so that it states the
// rules a second time. Every cell sends valid input through the JSON API to a real SQLite
// database, and checks the answer's status. A refused request must change nothing.
//
// How to read a cell:
//   OK       allowed (any 2xx answer). Asking for what is already true is allowed and
//            changes nothing, as the README says of asking the customer again.
//   SIGN_IN  401: nobody is signed in.
//   HIDDEN   404: this caller cannot see the ticket, so it is not told the ticket exists.
//   NO       403: the caller can see the ticket, but is not someone who may do this.
//   NOT_NOW  409: the caller may do this, but not while the ticket is in this state.
//   REFUSED  403 or 409: both of the last two apply, and the rules do not rank them.
//   SEES     the list answers 200 and holds the ticket.
//   EMPTY    the list answers 200 and does not hold the ticket.
//   NOTES    the conversation answers 200 and holds the team's internal note.
//   NO_NOTES the conversation answers 200 without the team's internal note.
//   TEXT_ONLY the edit is allowed, but the customer's own check keeps their words.

const OK = "OK";
const SIGN_IN = 401;
const HIDDEN = 404;
const NO = 403;
const NOT_NOW = 409;
const REFUSED = "403 or 409";
const SEES = "SEES";
const EMPTY = "EMPTY";
const NOTES = "NOTES";
const NO_NOTES = "NO_NOTES";
const TEXT_ONLY = "TEXT_ONLY";
type Cell =
  | typeof OK
  | typeof SIGN_IN
  | typeof HIDDEN
  | typeof NO
  | typeof NOT_NOW
  | typeof REFUSED
  | typeof SEES
  | typeof EMPTY
  | typeof NOTES
  | typeof NO_NOTES
  | typeof TEXT_ONLY;

// The ticket's states, in the order of every row below. "new" has no owner yet; "taken" is
// still New, with an owner who has not started work. In "in progress" the owner has linked
// a change and handed the ticket to an agent. In "waiting" the owner has asked the customer
// "Did this fix it?". "yes" is resolved by the customer's Yes, "team" resolved by the owner
// with a reason, and "archived" was archived while in progress.
const STATES = ["new", "taken", "in progress", "waiting", "yes", "team", "archived"] as const;
type State = (typeof STATES)[number];

// Who is asking. The team has one member and one admin, so "teamNotOwner" is the team member
// on a ticket the admin owns; on every other row the team member owns the ticket (in "new"
// nobody does yet, so there "owner" is a team member who has not taken it). The two demo
// people ask on the demo, on a copy of the same ticket.
const WHO = [
  "filer", // the customer who filed the ticket
  "otherCustomer", // another customer
  "owner", // the team member who owns the ticket
  "teamNotOwner", // a team member who does not own it
  "demoTeam", // the demo's team member, who does not own it either
  "admin", // an admin who does not own it
  "preview", // the demo's read-only admin preview
  "handedAgent", // an agent key the owner handed the ticket to while it was in progress
  "otherAgent", // an agent key holding every scope that was never handed the ticket
  "nobody", // nobody signed in
] as const;
type Who = (typeof WHO)[number];

type Row = Record<Who, Cell[]>;

/** The same answer in every state. */
function all(cell: Cell): Cell[] {
  return STATES.map(() => cell);
}

/** An agent sees a ticket only while it is handed to it: in progress, here. */
function whileHanded(cell: Cell): Cell[] {
  return [HIDDEN, HIDDEN, cell, HIDDEN, HIDDEN, HIDDEN, HIDDEN];
}

// Rows that do not change from action to action.
const outsiders = {
  otherCustomer: all(HIDDEN),
  otherAgent: all(HIDDEN),
  nobody: all(SIGN_IN),
};
const reading: Row = {
  filer: [OK, OK, OK, OK, OK, OK, HIDDEN],
  owner: all(OK),
  teamNotOwner: all(OK),
  demoTeam: all(OK),
  admin: all(OK),
  preview: all(OK),
  handedAgent: whileHanded(OK),
  ...outsiders,
};
// Team work on the ticket's content: anyone on the team, until it is archived.
const teamWork: Cell[] = [OK, OK, OK, OK, OK, OK, NOT_NOW];
// What an agent with a scope for it may also do.
const teamWorkWithScope: Row = {
  filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
  owner: teamWork,
  teamNotOwner: teamWork,
  demoTeam: teamWork,
  admin: teamWork,
  preview: all(NO),
  handedAgent: whileHanded(OK),
  ...outsiders,
};

// Each row, left to right: new, taken, in progress, waiting, yes, team, archived.
const TABLE: Record<string, Row> = {
  list_tickets: {
    filer: [SEES, SEES, SEES, SEES, SEES, SEES, EMPTY],
    otherCustomer: all(EMPTY),
    owner: [SEES, SEES, SEES, SEES, SEES, SEES, EMPTY],
    teamNotOwner: [SEES, SEES, SEES, SEES, SEES, SEES, EMPTY],
    demoTeam: [SEES, SEES, SEES, SEES, SEES, SEES, EMPTY],
    admin: [SEES, SEES, SEES, SEES, SEES, SEES, EMPTY],
    preview: [SEES, SEES, SEES, SEES, SEES, SEES, EMPTY],
    handedAgent: [EMPTY, EMPTY, SEES, EMPTY, EMPTY, EMPTY, EMPTY],
    otherAgent: all(EMPTY),
    nobody: all(SIGN_IN),
  },
  // The archived list, GET /api/tickets?status=archived: for the team, never for an agent.
  list_archived: {
    filer: all(NO),
    otherCustomer: all(NO),
    owner: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, SEES],
    teamNotOwner: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, SEES],
    demoTeam: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, SEES],
    admin: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, SEES],
    preview: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, SEES],
    handedAgent: all(NO),
    otherAgent: all(NO),
    nobody: all(SIGN_IN),
  },
  // Anyone signed in files a ticket; an agent never does.
  create_ticket: {
    filer: all(OK),
    otherCustomer: all(OK),
    owner: all(OK),
    teamNotOwner: all(OK),
    demoTeam: all(OK),
    admin: all(OK),
    preview: all(NO),
    handedAgent: all(NO),
    otherAgent: all(NO),
    nobody: all(SIGN_IN),
  },
  get_ticket: reading,
  // The conversation: internal notes are for the team, and for an agent only with read_notes.
  list_entries: {
    filer: [NO_NOTES, NO_NOTES, NO_NOTES, NO_NOTES, NO_NOTES, NO_NOTES, HIDDEN],
    owner: all(NOTES),
    teamNotOwner: all(NOTES),
    demoTeam: all(NOTES),
    admin: all(NOTES),
    preview: all(NOTES),
    handedAgent: whileHanded(NO_NOTES),
    ...outsiders,
  },
  list_evidence: reading,
  list_events: reading,
  // Only the owner starts work, and only on a New ticket. A customer never changes a status.
  change_status: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [REFUSED, OK, OK, OK, NOT_NOW, NOT_NOW, NOT_NOW],
    teamNotOwner: [REFUSED, NO, NO, NO, REFUSED, REFUSED, REFUSED],
    demoTeam: [REFUSED, NO, NO, NO, REFUSED, REFUSED, REFUSED],
    admin: [REFUSED, NO, NO, NO, REFUSED, REFUSED, REFUSED],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The customer edits their own ticket and the team edits any, but never the customer's check.
  edit_ticket: {
    filer: [OK, OK, OK, OK, OK, OK, HIDDEN],
    owner: [TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, NOT_NOW],
    teamNotOwner: [TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, NOT_NOW],
    demoTeam: [TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, NOT_NOW],
    admin: [TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, TEXT_ONLY, NOT_NOW],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  agree_check: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: teamWork,
    teamNotOwner: teamWork,
    demoTeam: teamWork,
    admin: teamWork,
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // Only the customer who filed it adopts the team's wording.
  adopt_check: {
    filer: [OK, OK, OK, OK, OK, OK, HIDDEN],
    owner: [NO, NO, NO, NO, NO, NO, REFUSED],
    teamNotOwner: [NO, NO, NO, NO, NO, NO, REFUSED],
    demoTeam: [NO, NO, NO, NO, NO, NO, REFUSED],
    admin: [NO, NO, NO, NO, NO, NO, REFUSED],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The team links changes; the handed agent's key has no link_changes scope.
  link_change: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: teamWork,
    teamNotOwner: teamWork,
    demoTeam: teamWork,
    admin: teamWork,
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // Only the current owner asks the customer, on a ticket in progress.
  mark_ready: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [REFUSED, NOT_NOW, OK, OK, NOT_NOW, NOT_NOW, NOT_NOW],
    teamNotOwner: [REFUSED, REFUSED, NO, NO, REFUSED, REFUSED, REFUSED],
    demoTeam: [REFUSED, REFUSED, NO, NO, REFUSED, REFUSED, REFUSED],
    admin: [REFUSED, REFUSED, NO, NO, REFUSED, REFUSED, REFUSED],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The owner takes back the open question. With none open, nothing changes.
  withdraw_question: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [REFUSED, OK, OK, OK, OK, OK, NOT_NOW],
    teamNotOwner: [REFUSED, NO, NO, NO, NO, NO, REFUSED],
    demoTeam: [REFUSED, NO, NO, NO, NO, NO, REFUSED],
    admin: [REFUSED, NO, NO, NO, NO, NO, REFUSED],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // Only the customer who filed it answers "Did this fix it?", and only when asked.
  answer: {
    filer: [NOT_NOW, NOT_NOW, NOT_NOW, OK, NOT_NOW, NOT_NOW, HIDDEN],
    owner: [NO, NO, NO, NO, NO, NO, REFUSED],
    teamNotOwner: [NO, NO, NO, NO, NO, NO, REFUSED],
    demoTeam: [NO, NO, NO, NO, NO, NO, REFUSED],
    admin: [NO, NO, NO, NO, NO, NO, REFUSED],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // A team member takes an unowned ticket. Taking your own again changes nothing.
  take_ticket: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [OK, OK, OK, OK, OK, OK, NOT_NOW],
    teamNotOwner: [OK, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW],
    demoTeam: [OK, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW],
    admin: [OK, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  take_and_start: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [OK, OK, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW],
    teamNotOwner: [OK, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW],
    demoTeam: [OK, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW],
    admin: [OK, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The customer who filed a resolved ticket reopens it, however it was resolved. The owner or
  // an admin also reopens one the team resolved, but never one the customer confirmed fixed.
  reopen: {
    filer: [NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, OK, OK, HIDDEN],
    owner: [NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NO, OK, REFUSED],
    teamNotOwner: [REFUSED, REFUSED, REFUSED, REFUSED, NO, NO, REFUSED],
    demoTeam: [REFUSED, REFUSED, REFUSED, REFUSED, NO, NO, REFUSED],
    admin: [NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NO, OK, REFUSED],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The owner or an admin resolves a New or In Progress ticket with a reason, and any team
  // member resolves one nobody owns yet, becoming its owner. Never an agent.
  resolve_with_reason: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [OK, OK, OK, OK, NOT_NOW, NOT_NOW, NOT_NOW],
    teamNotOwner: [OK, NO, NO, NO, REFUSED, REFUSED, REFUSED],
    demoTeam: [OK, NO, NO, NO, REFUSED, REFUSED, REFUSED],
    admin: [OK, OK, OK, OK, NOT_NOW, NOT_NOW, NOT_NOW],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The owner or an admin hands an open ticket to another team member.
  hand_off: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [REFUSED, OK, OK, OK, NOT_NOW, NOT_NOW, NOT_NOW],
    teamNotOwner: [REFUSED, NO, NO, NO, REFUSED, REFUSED, REFUSED],
    demoTeam: [REFUSED, NO, NO, NO, REFUSED, REFUSED, REFUSED],
    admin: [OK, OK, OK, OK, NOT_NOW, NOT_NOW, NOT_NOW],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The owner hands an in-progress ticket to an agent connection.
  give_to_agent: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [REFUSED, NOT_NOW, OK, OK, NOT_NOW, NOT_NOW, NOT_NOW],
    teamNotOwner: [REFUSED, REFUSED, NO, NO, REFUSED, REFUSED, REFUSED],
    demoTeam: [REFUSED, REFUSED, NO, NO, REFUSED, REFUSED, REFUSED],
    admin: [REFUSED, REFUSED, NO, NO, REFUSED, REFUSED, REFUSED],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The owner or an admin ends an agent's work. With no agent at work, nothing changes.
  end_agent_work: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [REFUSED, OK, OK, OK, OK, OK, NOT_NOW],
    teamNotOwner: [REFUSED, NO, NO, NO, NO, NO, REFUSED],
    demoTeam: [REFUSED, NO, NO, NO, NO, NO, REFUSED],
    admin: [OK, OK, OK, OK, OK, OK, NOT_NOW],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The owner lets go of a ticket before work starts.
  release_ticket: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: [REFUSED, OK, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW],
    teamNotOwner: [REFUSED, NO, REFUSED, REFUSED, REFUSED, REFUSED, REFUSED],
    demoTeam: [REFUSED, NO, REFUSED, REFUSED, REFUSED, REFUSED, REFUSED],
    admin: [REFUSED, NO, REFUSED, REFUSED, REFUSED, REFUSED, REFUSED],
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The team, or the customer who filed it. Archiving it again changes nothing. Never on
  // the demo, so that one visitor cannot empty it for the next.
  archive_ticket: {
    filer: [OK, OK, OK, OK, OK, OK, HIDDEN],
    owner: all(OK),
    teamNotOwner: all(OK),
    demoTeam: all(NO),
    admin: all(OK),
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // The team brings an archived ticket back. On one that is not archived, nothing changes.
  // Never on the demo.
  restore_ticket: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: all(OK),
    teamNotOwner: all(OK),
    demoTeam: all(NO),
    admin: all(OK),
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // Only an admin deletes permanently, in any state.
  delete_ticket: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: all(NO),
    teamNotOwner: all(NO),
    demoTeam: all(NO),
    admin: all(OK),
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  // A reply the customer sees: the team, or the customer who filed it. Never an agent.
  add_entry: {
    filer: [OK, OK, OK, OK, OK, OK, HIDDEN],
    owner: teamWork,
    teamNotOwner: teamWork,
    demoTeam: teamWork,
    admin: teamWork,
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
  add_note: teamWorkWithScope,
  add_evidence: teamWorkWithScope,
  propose_spec: teamWorkWithScope,
  ask_owner_to_review: teamWorkWithScope,
  // A person on the team accepts or discards a spec; an agent only proposes one.
  decide_spec: {
    filer: [NO, NO, NO, NO, NO, NO, HIDDEN],
    owner: teamWork,
    teamNotOwner: teamWork,
    demoTeam: teamWork,
    admin: teamWork,
    preview: all(NO),
    handedAgent: whileHanded(NO),
    ...outsiders,
  },
};

// Cells where the code answers differently from the table. The table keeps the rules'
// answer; the test expects the code's answer here, and fails once the two agree, so that the
// entry is removed. Keyed "action / who / state". Each one must be a request that changes
// nothing, and the test checks that it changed nothing. There are none now: a request that
// would change nothing is still refused when the rules refuse it.
const KNOWN_DISAGREEMENTS: Record<string, { code: Cell; why: string }> = {};

// ---- The ticket in each state, built once through the API ---------------------------------

const TICKET = "SUP-1";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "permission-matrix-"));
const devConfig = loadConfig({ DEV_SIGN_IN: "on" });
const demoConfig = loadConfig({ DEMO: "on" });
const openDbs: Db[] = [];
afterAll(() => {
  for (const db of openDbs.splice(0)) if (db.open) db.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A ticket in one state, saved as a database image with what the cells need to know. */
type Template = {
  bytes: Buffer;
  owner: string | null;
  readyToken: string;
  handedKey: string;
  otherKey: string;
};

// The two connections are the first two on a new database, so their ids are known.
const HANDED_CONNECTION = 1;
const OTHER_CONNECTION = 2;

function must<T extends { status: number; text: string }>(res: T, step: string): T {
  if (res.status >= 300) throw new Error(`Setup step "${step}" got ${res.status}: ${res.text}`);
  return res;
}

async function issueKey(app: Express, name: string, scopes: string[]) {
  const res = must(
    await as(app, adminActor).post("/connections").type("form").send({ name, scopes }),
    "issue a key",
  );
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
}

/** Builds the ticket in this state, owned (from "taken" on) by this person. */
async function buildTemplate(state: State, owner: Actor): Promise<Template> {
  const { app, db } = buildTestApp();
  must(
    await as(app, customerOne).post("/api/tickets").send({
      title: "Printer jams",
      description: "It jams on page two.",
      fix_check: FIRST_CHECK,
    }),
    "file",
  );
  // The handed key can read, write notes, attach evidence and propose specs, but not link
  // changes or read notes. The other key holds every scope and is never handed anything.
  const handedKey = await issueKey(app, "Handed", [
    "read_tickets",
    "write_notes",
    "attach_evidence",
    "propose_specs",
  ]);
  const otherKey = await issueKey(app, "Other", [
    "read_tickets",
    "read_notes",
    "write_notes",
    "attach_evidence",
    "propose_specs",
    "link_changes",
  ]);
  // The team's wording to adopt and a spec to decide on, in every state.
  must(
    await as(app, teamActor)
      .put(`/api/tickets/${TICKET}/agreed-check`)
      .send({ agreed_check: "Ten pages print without a jam" }),
    "agree a check",
  );
  must(await as(app, teamActor).post(`/api/tickets/${TICKET}/spec`).send(SPEC), "propose a spec");
  must(
    await as(app, teamActor)
      .post(`/api/tickets/${TICKET}/notes`)
      .send({ body: "Tray two is worn." }),
    "write an internal note",
  );
  let readyToken = "none-asked";
  if (state !== "new") {
    must(await as(app, owner).post(`/api/tickets/${TICKET}/take`), "take");
  }
  if (state !== "new" && state !== "taken") {
    const byOwner = as(app, owner);
    must(await byOwner.patch(`/api/tickets/${TICKET}`).send({ status: "in_progress" }), "start");
    must(
      await byOwner
        .put(`/api/tickets/${TICKET}/change-link`)
        .send({ change_url: "https://example.com/change/1" }),
      "link a change",
    );
    must(
      await byOwner.post(`/api/tickets/${TICKET}/agent`).send({ connection_id: HANDED_CONNECTION }),
      "hand to the agent",
    );
  }
  if (state === "waiting" || state === "yes") {
    const asked = must(
      await as(app, owner).post(`/api/tickets/${TICKET}/ready`).send(ASK),
      "ask the customer",
    );
    readyToken = asked.body.ready_token;
  }
  if (state === "yes") {
    must(
      await as(app, customerOne)
        .post(`/api/tickets/${TICKET}/answer`)
        .send({ fixed: "yes", ready_token: readyToken }),
      "answer yes",
    );
  }
  if (state === "team") {
    must(await as(app, owner).post(`/api/tickets/${TICKET}/resolve`).send(RESOLVE), "resolve");
  }
  if (state === "archived") {
    must(await as(app, owner).post(`/api/tickets/${TICKET}/archive`), "archive");
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  return {
    bytes: db.serialize(),
    owner: state === "new" ? null : owner.id,
    readyToken,
    handedKey,
    otherKey,
  };
}

// Every request goes over one kept-alive connection per server. Opening a new connection for
// each of the two thousand requests can run a busy machine out of local ports.
const keepAlive = new http.Agent({ keepAlive: true });
const servers: Server[] = [];
afterAll(() => keepAlive.destroy());

/** A new server on its own copy of the template's database, and its address. */
async function serverFrom(template: Template, demo: boolean) {
  const file = path.join(workDir, `${openDbs.length}.db`);
  fs.writeFileSync(file, template.bytes);
  const db = openDatabase(file);
  openDbs.push(db);
  // The demo refuses a database labelled for real tickets, so the demo's copy is relabelled.
  if (demo) db.prepare("UPDATE app_meta SET value = 'demo' WHERE key = 'purpose'").run();
  const server = await listenLocally(createApp(demo ? demoConfig : devConfig, db));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { address: `http://127.0.0.1:${port}`, db };
}

// ---- Valid input for every action ----------------------------------------------------------

const SPEC = {
  summary: "Ten pages print with no jam.",
  scenarios: [
    { title: "Ten pages", given: "A full tray", when: "Ten pages print", then: "None jams" },
  ],
};
const ASK = {
  try_url: "https://example.com/try",
  tried: "I printed ten pages.",
  result: "No jam.",
};
const RESOLVE = { reason: "wont_fix", note: "It works as designed." };
const FIRST_CHECK = "Ten pages print";
const NEW_CHECK = "Twelve pages print";

type Method = "get" | "post" | "put" | "patch" | "delete";
type Call = { method: Method; path: string; body?: object };

function callFor(action: string, template: Template, demo: boolean): Call {
  const at = `/api/tickets/${TICKET}`;
  const post = (suffix: string, body?: object): Call => ({
    method: "post",
    path: at + suffix,
    body,
  });
  // A hand-off goes to a team member who does not own the ticket now: on the demo its own
  // team member, elsewhere whichever of the two team people is not the owner.
  let handTo = template.owner === adminActor.id ? teamActor.id : adminActor.id;
  if (demo) handTo = "demo-team";
  const calls: Record<string, Call> = {
    list_tickets: { method: "get", path: "/api/tickets" },
    list_archived: { method: "get", path: "/api/tickets?status=archived" },
    create_ticket: {
      method: "post",
      path: "/api/tickets",
      body: { title: "Scanner stalls", description: "It stops halfway.", fix_check: "It scans" },
    },
    get_ticket: { method: "get", path: at },
    change_status: { method: "patch", path: at, body: { status: "in_progress" } },
    edit_ticket: {
      method: "put",
      path: at,
      body: {
        title: "Printer jams on page two",
        description: "It jams.",
        fix_check: NEW_CHECK,
      },
    },
    agree_check: {
      method: "put",
      path: `${at}/agreed-check`,
      body: { agreed_check: "Twenty pages print" },
    },
    adopt_check: post("/adopt-check"),
    link_change: {
      method: "put",
      path: `${at}/change-link`,
      body: { change_url: "https://example.com/change/2" },
    },
    mark_ready: post("/ready", ASK),
    withdraw_question: post("/withdraw-question"),
    answer: post("/answer", { fixed: "yes", ready_token: template.readyToken }),
    take_ticket: post("/take"),
    take_and_start: post("/take-and-start"),
    reopen: post("/reopen", { reason: "It still jams." }),
    resolve_with_reason: post("/resolve", RESOLVE),
    hand_off: post("/hand-off", { to: handTo, expected_owner: template.owner ?? "" }),
    give_to_agent: post("/agent", { connection_id: OTHER_CONNECTION }),
    end_agent_work: post("/agent/end"),
    release_ticket: post("/release"),
    archive_ticket: post("/archive"),
    restore_ticket: post("/restore"),
    delete_ticket: { method: "delete", path: at, body: { confirm: TICKET } },
    list_entries: { method: "get", path: `${at}/entries` },
    add_entry: post("/entries", { kind: "reply", body: "We are looking at it." }),
    add_note: post("/notes", { body: "Tray two is worn." }),
    list_evidence: { method: "get", path: `${at}/evidence` },
    add_evidence: post("/evidence", { kind: "test", summary: "Ten pages printed." }),
    propose_spec: post("/spec", SPEC),
    decide_spec: post("/spec/decision", { decision: "accept" }),
    ask_owner_to_review: post("/owner-review", { message: "The test passes." }),
    list_events: { method: "get", path: `${at}/events` },
  };
  return calls[action]!;
}

// The person each caller signs in as, through the development or the demo entrance.
const SIGNED_IN_AS: Partial<Record<Who, string>> = {
  filer: customerOne.id,
  otherCustomer: customerTwo.id,
  owner: teamActor.id,
  teamNotOwner: teamActor.id,
  admin: adminActor.id,
  preview: "demo-admin",
  demoTeam: "demo-team",
};

/** Sends one call as one caller: a person from a page of this site, or an agent with its key. */
function send(address: string, who: Who, template: Template, call: Call) {
  const pending = request(address)[call.method](call.path).agent(keepAlive);
  if (who === "handedAgent") pending.set("Authorization", `Bearer ${template.handedKey}`);
  else if (who === "otherAgent") pending.set("Authorization", `Bearer ${template.otherKey}`);
  else pending.set(FROM_THIS_SITE);
  const id = SIGNED_IN_AS[who];
  if (id !== undefined) pending.set("Cookie", `${DEV_COOKIE}=${id}`);
  return call.body === undefined ? pending : pending.send(call.body);
}

/** What the answer was, in the table's terms. */
function outcome(status: number, body: unknown, action: string): Cell | number {
  const isList = action === "list_tickets" || action === "list_archived";
  if (isList && status === 200) {
    const keys = (body as { key: string }[]).map((ticket) => ticket.key);
    return keys.includes(TICKET) ? SEES : EMPTY;
  }
  if (status < 200 || status >= 300) return status;
  if (action === "list_entries") {
    const kinds = (body as { kind: string }[]).map((entry) => entry.kind);
    return kinds.includes("note") ? NOTES : NO_NOTES;
  }
  if (action === "edit_ticket") {
    return (body as { fix_check: string }).fix_check === NEW_CHECK ? OK : TEXT_ONLY;
  }
  return OK;
}

function matches(expected: Cell, got: Cell | number): boolean {
  if (expected === REFUSED) return got === NO || got === NOT_NOW;
  return got === expected;
}

/** What may change in the database: the history and the ticket's row. */
function snapshot(db: Db): string {
  const events = db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get();
  const tickets = db.prepare("SELECT * FROM tickets ORDER BY id").all();
  return JSON.stringify({ events, tickets });
}

// ---- The test ------------------------------------------------------------------------------

// The whole file takes a few seconds. The limits leave room for a machine busy with other work.
const BUILD_TIME_LIMIT = 60_000;
const CELL_TIME_LIMIT = 30_000;

describe("who may do what, in every ticket state", () => {
  const templates = new Map<string, Template>();
  const templateFor = (state: State, who: Who) =>
    templates.get(`${state} ${who === "teamNotOwner" ? "admin" : "team"}`)!;

  beforeAll(async () => {
    for (const state of STATES) {
      templates.set(`${state} team`, await buildTemplate(state, teamActor));
      templates.set(`${state} admin`, await buildTemplate(state, adminActor));
    }
  }, BUILD_TIME_LIMIT);

  it("has a row for every action in the product's action table", () => {
    // Every action, and the archived list, which is the list action with a filter.
    const names = [...ACTIONS.map((action) => action.name), "list_archived"];
    expect(Object.keys(TABLE).sort()).toEqual(names.sort());
    for (const [action, row] of Object.entries(TABLE)) {
      for (const who of WHO) expect(row[who], `${action} / ${who}`).toHaveLength(STATES.length);
    }
  });

  for (const state of STATES) {
    for (const who of WHO) {
      it(
        `${who}, on a ticket that is ${state}`,
        async () => {
          const template = templateFor(state, who);
          const demo = who === "preview" || who === "demoTeam";
          // One copy serves every call expected to change nothing; each call expected to
          // succeed and change something gets a fresh copy of its own.
          const shared = await serverFrom(template, demo);
          const wrong: string[] = [];
          for (const [action, row] of Object.entries(TABLE)) {
            const name = `${action} / ${who} / ${state}`;
            const ruled = row[who][STATES.indexOf(state)]!;
            const known = KNOWN_DISAGREEMENTS[name];
            const expected = known?.code ?? ruled;
            const call = callFor(action, template, demo);
            const changes = call.method !== "get" && (ruled === OK || ruled === TEXT_ONLY);
            const { address, db } = changes ? await serverFrom(template, demo) : shared;
            const before = snapshot(db);
            const res = await send(address, who, template, call);
            const got = outcome(res.status, res.body, action);
            if (!matches(expected, got)) {
              wrong.push(`${name}: expected ${expected}, got ${got} ${res.text.slice(0, 120)}`);
            } else if (known !== undefined && matches(ruled, got)) {
              wrong.push(`${name}: now agrees with the table; remove it from KNOWN_DISAGREEMENTS`);
            }
            if (!changes && snapshot(db) !== before) wrong.push(`${name}: changed the database`);
          }
          await closeServers(servers);
          expect(wrong).toEqual([]);
        },
        CELL_TIME_LIMIT,
      );
    }
  }
});
