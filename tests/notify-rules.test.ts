import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { noticesFor, TOLD, type Audience, type EventFacts } from "../src/server/notify/rules.js";

// Who is told about what, decided by hand for every kind of history event there is. A kind of
// event that the ticket service writes and this table leaves out fails the first test, so a new
// kind cannot be forgotten: someone must decide who, if anyone, hears about it.
const EXPECTED: Record<string, Audience[]> = {
  created: [],
  status_changed: [],
  edited: [],
  check_agreed: [],
  check_adopted: [],
  change_linked: [],
  ready_for_customer: ["customer"],
  question_withdrawn: [],
  customer_answered: ["owner"],
  reopened: ["owner"],
  resolved_by_team: ["customer"],
  owner_changed: ["owner"],
  reply_added: ["customer", "owner"],
  note_added: [],
  review_requested: [],
  evidence_added: [],
  spec_proposed: [],
  spec_accepted: [],
  spec_discarded: [],
  agent_handed: [],
  agent_handoff_ended: [],
  archived: [],
  restored: [],
};

const SERVICE = path.join(__dirname, "..", "src", "server", "tickets", "service.ts");

/** Every history event type the ticket service writes, read from its source. */
function eventTypesInService(): string[] {
  const source = fs.readFileSync(SERVICE, "utf8").replace(/\s+/g, " ");
  const types = new Set<string>();
  // log(ticketId, actor, <type>, data, now): the type is a word, or a choice between words.
  for (const call of source.matchAll(/\blog\( ?[\w.]+, actor, ([^,]+),/g)) {
    // The words being chosen, not the ones they are compared with.
    for (const word of (call[1] ?? "").matchAll(/(?<!=== )"([a-z_]+)"/g)) types.add(word[1]!);
  }
  // logEvent({ ..., type: "<type>", ... })
  for (const field of source.matchAll(/\btype: "([a-z_]+)"/g)) types.add(field[1]!);
  return [...types].sort();
}

/** Facts that would tell everyone they could: both people exist, a team reply was found. */
function fullFacts(type: string, overrides: Partial<EventFacts> = {}): EventFacts {
  return {
    type,
    actorId: "someone-else",
    actorKind: "person",
    data: { fixed: false, comment: "Still broken" },
    customerId: "customer-1",
    ownerId: "owner-1",
    replyAuthorRole: "team",
    ...overrides,
  };
}

describe("the list of who is told", () => {
  it("names every kind of history event the ticket service writes", () => {
    const found = eventTypesInService();
    // The reading of the source works: it finds the kinds written in each way.
    expect(found).toContain("created");
    expect(found).toContain("note_added");
    expect(found).toContain("agent_handed");
    expect(found).toEqual(Object.keys(EXPECTED).sort());
  });

  it("is the only place events are written from", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full, "utf8").includes("insertEvent(")) callers.push(entry.name);
      }
    };
    walk(path.join(__dirname, "..", "src", "server"));
    // The repository defines it; only the ticket service calls it.
    expect(callers.sort()).toEqual(["repository.ts", "service.ts"]);
  });

  it.each(Object.entries(EXPECTED))("tells about %s exactly whom the table says", (type, who) => {
    expect(TOLD.get(type) ?? []).toEqual(who);
  });

  it("allows nothing that is not in the table", () => {
    for (const type of TOLD.keys()) expect(Object.keys(EXPECTED)).toContain(type);
  });

  it("tells nobody about a kind of event it has not heard of", () => {
    for (const type of ["something_new", "constructor", "__proto__", "toString"]) {
      expect(noticesFor(fullFacts(type))).toEqual([]);
    }
  });

  it.each(Object.entries(EXPECTED).filter(([, who]) => who.length === 0))(
    "tells nobody about %s, whatever the facts",
    (type) => {
      for (const replyAuthorRole of ["team", "customer", null] as const) {
        expect(noticesFor(fullFacts(type, { replyAuthorRole }))).toEqual([]);
      }
    },
  );
});

describe("the rules every notice keeps", () => {
  it("never tells anyone about an assistant's work", () => {
    for (const type of Object.keys(EXPECTED)) {
      for (const replyAuthorRole of ["team", "customer"] as const) {
        expect(noticesFor(fullFacts(type, { actorKind: "agent", replyAuthorRole }))).toEqual([]);
      }
    }
  });

  it("never tells anyone about their own action", () => {
    const asCustomer = { actorId: "customer-1", replyAuthorRole: "customer" as const };
    const asOwner = { actorId: "owner-1", replyAuthorRole: "team" as const };
    for (const type of Object.keys(EXPECTED)) {
      for (const notice of noticesFor(fullFacts(type, asCustomer))) {
        expect(notice.recipientId).not.toBe("customer-1");
      }
      for (const notice of noticesFor(fullFacts(type, asOwner))) {
        expect(notice.recipientId).not.toBe("owner-1");
      }
    }
    // The owner who hands a ticket to themselves, or replies to their own ticket, hears nothing.
    expect(noticesFor(fullFacts("owner_changed", { actorId: "owner-1" }))).toEqual([]);
    expect(
      noticesFor(fullFacts("reply_added", { actorId: "customer-1", ownerId: "customer-1" })),
    ).toEqual([]);
  });

  it("never sends a notice to an assistant's connection", () => {
    for (const type of Object.keys(EXPECTED)) {
      const facts = fullFacts(type, { customerId: "connection-3", ownerId: "connection-4" });
      expect(noticesFor(facts)).toEqual([]);
    }
  });

  it("sends a team reply to the customer and a customer's reply to the owner", () => {
    expect(noticesFor(fullFacts("reply_added", { replyAuthorRole: "team" }))).toEqual([
      { recipientId: "customer-1", kind: "team_replied", audience: "customer" },
    ]);
    expect(noticesFor(fullFacts("reply_added", { replyAuthorRole: "admin" }))).toEqual([
      { recipientId: "customer-1", kind: "team_replied", audience: "customer" },
    ]);
    expect(
      noticesFor(fullFacts("reply_added", { actorId: "customer-1", replyAuthorRole: "customer" })),
    ).toEqual([{ recipientId: "owner-1", kind: "customer_replied", audience: "owner" }]);
    // No public reply found: nothing, rather than a guess.
    expect(noticesFor(fullFacts("reply_added", { replyAuthorRole: null }))).toEqual([]);
  });

  it("tells the owner about a No, and nobody about a Yes", () => {
    const no = fullFacts("customer_answered", { actorId: "customer-1" });
    expect(noticesFor(no)).toEqual([
      { recipientId: "owner-1", kind: "customer_said_no", audience: "owner" },
    ]);
    expect(noticesFor({ ...no, data: { fixed: true } })).toEqual([]);
    expect(noticesFor({ ...no, data: null })).toEqual([]);
  });

  it("tells nobody when there is nobody to tell", () => {
    for (const type of Object.keys(EXPECTED)) {
      expect(noticesFor(fullFacts(type, { customerId: null, ownerId: null }))).toEqual([]);
    }
  });
});
