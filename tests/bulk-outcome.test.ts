import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { rememberBulkOutcome, takeBulkOutcome } from "../src/server/pages/bulk-outcome.js";

// The line the ticket list shows after changing ticked tickets comes from a cookie that holds
// only the change, a count and error codes by key. Words typed in the form never go into it, and
// a cookie in any other shape shows nothing.

function fakeResponse() {
  const set: Record<string, string> = {};
  const res = {
    cookie: (name: string, value: string) => {
      set[name] = value;
    },
    clearCookie: () => undefined,
  } as unknown as Response;
  return { res, set };
}
const requestWith = (value: unknown) =>
  ({ cookies: { bulk_outcome: value } }) as unknown as Request;
const names = (id: string) => (id === "dev-team-1" ? "Team Member" : undefined);

describe("the line after a change to many tickets", () => {
  it("keeps the words of the form out of the cookie", () => {
    const { res, set } = fakeResponse();
    rememberBulkOutcome(res, [
      {
        change: { status: "resolved", reason: "other", note: "<b>typed words</b>" },
        changed: ["SUP-1"],
        not_changed: [
          {
            key: "SUP-2",
            status: 409,
            code: "not_open",
            message: "Ticket SUP-2 is already resolved.",
          },
        ],
      },
    ]);
    expect(set.bulk_outcome).not.toContain("typed words");
    expect(set.bulk_outcome).not.toContain("is already resolved");
    expect(takeBulkOutcome(requestWith(set.bulk_outcome), fakeResponse().res, names)).toBe(
      "1 moved to Resolved. 1 was not changed: SUP-2 (already resolved).",
    );
  });

  it("names the team member tickets were assigned to", () => {
    const { res, set } = fakeResponse();
    rememberBulkOutcome(res, [
      { change: { owner: "dev-team-1" }, changed: ["SUP-1", "SUP-2"], not_changed: [] },
    ]);
    expect(takeBulkOutcome(requestWith(set.bulk_outcome), fakeResponse().res, names)).toBe(
      "2 assigned to Team Member.",
    );
  });

  it("says both changes when one Apply set a status and an owner", () => {
    const { res, set } = fakeResponse();
    rememberBulkOutcome(res, [
      { change: { status: "in_progress" }, changed: ["SUP-1", "SUP-2"], not_changed: [] },
      { change: { owner: "dev-team-1" }, changed: ["SUP-1", "SUP-2"], not_changed: [] },
    ]);
    expect(takeBulkOutcome(requestWith(set.bulk_outcome), fakeResponse().res, names)).toBe(
      "2 moved to In Progress. 2 assigned to Team Member.",
    );
  });

  it("shows nothing for a cookie it did not write", () => {
    const { res } = fakeResponse();
    expect(takeBulkOutcome(requestWith("not json"), res, names)).toBeNull();
    expect(takeBulkOutcome(requestWith(JSON.stringify({ line: "Hello" })), res, names)).toBeNull();
    expect(takeBulkOutcome(requestWith(undefined), res, names)).toBeNull();
  });
});
