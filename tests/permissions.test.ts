import { describe, expect, it } from "vitest";
import { can, type Action, type TicketFacts } from "../src/server/permissions.js";
import { adminActor, customerOne, customerTwo, teamActor } from "./helpers.js";

const own: TicketFacts = { created_by: customerOne.id, archived_at: null };
const ownArchived: TicketFacts = {
  created_by: customerOne.id,
  archived_at: "2026-01-01T00:00:00.000Z",
};

describe("can", () => {
  // [who, action, ticket, expected]
  const table: [string, typeof adminActor, Action, TicketFacts | undefined, boolean][] = [
    ["anyone files a ticket", customerOne, "create", undefined, true],
    ["a customer does not list every ticket", customerOne, "list_all", undefined, false],
    ["a team member lists every ticket", teamActor, "list_all", undefined, true],
    ["a customer does not list archived tickets", customerOne, "list_archived", undefined, false],
    ["a team member lists archived tickets", teamActor, "list_archived", undefined, true],
    ["an admin lists archived tickets", adminActor, "list_archived", undefined, true],

    ["a customer reads their own ticket", customerOne, "read", own, true],
    ["a customer does not read another's ticket", customerTwo, "read", own, false],
    ["a team member reads any ticket", teamActor, "read", own, true],

    ["a customer edits their own ticket", customerOne, "edit", own, true],
    ["a customer does not edit another's ticket", customerTwo, "edit", own, false],
    ["a team member edits any ticket", teamActor, "edit", own, true],

    [
      "a customer does not change a status, even their own",
      customerOne,
      "change_status",
      own,
      false,
    ],
    ["a team member changes a status", teamActor, "change_status", own, true],

    ["a customer archives their own ticket", customerOne, "archive", own, true],
    ["a customer does not archive another's ticket", customerTwo, "archive", own, false],
    ["a team member archives any ticket", teamActor, "archive", own, true],

    ["an archived ticket is gone for its own customer", customerOne, "read", ownArchived, false],
    ["a team member reads an archived ticket", teamActor, "read", ownArchived, true],
    [
      "a customer does not archive what is already archived",
      customerOne,
      "archive",
      ownArchived,
      false,
    ],
    ["an admin reads an archived ticket", adminActor, "read", ownArchived, true],
    ["a customer does not restore", customerOne, "restore", ownArchived, false],
    ["a team member restores", teamActor, "restore", ownArchived, true],
    ["an admin restores", adminActor, "restore", ownArchived, true],

    ["a ticket action without a ticket is refused", adminActor, "read", undefined, false],
  ];

  it.each(table)("%s", (_name, who, action, ticket, expected) => {
    expect(can(who, action, ticket)).toBe(expected);
  });
});
