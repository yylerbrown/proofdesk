import { describe, expect, it } from "vitest";
import {
  cardLine,
  cardLineText,
  formatDay,
  type CardFacts,
  type CardLine,
} from "../src/server/pages/format.js";
import type { Ticket } from "../src/server/tickets/service.js";

// The one line on the ticket page's card, under the customer's check: where the ticket stands,
// for the person looking. One test for each row of the design review's table of what the card
// holds, by state. A line that says nothing new is left out, so most rows have none.

const at = "2026-11-19T16:07:00.000Z";

/** A ticket with only the fields the card's line reads; the rest do not matter here. */
function ticket(fields: Partial<Ticket> = {}): Ticket {
  return {
    status: "new",
    owner_id: null,
    owner_name: null,
    ready_at: null,
    archived_at: null,
    resolution: null,
    customer_answer: null,
    ...fields,
  } as Ticket;
}

/** The line's words as a page without scripts shows them, its day in UTC. */
const words = (line: CardLine | null) => (line === null ? null : cardLineText(line));

const nothing: CardFacts = { confirmed: null, notFixed: null, reviewBy: null };
const mine = { status: "in_progress", owner_id: "team-1", owner_name: "Team Member" } as const;

describe("the card's line", () => {
  it("says nothing on a New ticket with no owner", () => {
    expect(cardLine(ticket(), "team", nothing)).toBeNull();
  });

  it("says nothing on a New ticket the viewer owns", () => {
    expect(cardLine(ticket({ owner_id: "team-1" }), "team", nothing)).toBeNull();
  });

  it("says nothing on an In Progress ticket, the viewer's or someone else's", () => {
    expect(cardLine(ticket(mine), "team", nothing)).toBeNull();
    expect(cardLine(ticket(mine), "admin", nothing)).toBeNull();
  });

  it("says an assistant asks for a review, to the team only", () => {
    const facts = { ...nothing, reviewBy: "Demo visitor's assistant" };
    expect(cardLine(ticket(mine), "team", facts)).toEqual({
      text: "Demo visitor's assistant asks for your review.",
      day: null,
      after: "",
      tick: false,
      messageAt: null,
    });
    expect(cardLine(ticket(mine), "customer", facts)).toBeNull();
  });

  it("tells the team it waits for the customer once they are asked", () => {
    const asked = ticket({ ...mine, ready_at: at });
    expect(words(cardLine(asked, "team", nothing))).toBe(
      "Waiting for the customer's answer. Asked 19 Nov 2026.",
    );
  });

  it("leaves the asked customer's card to its question, with no line", () => {
    expect(cardLine(ticket({ ...mine, ready_at: at }), "customer", nothing)).toBeNull();
  });

  it("tells the team the customer said no, linked to their message", () => {
    const facts = { ...nothing, notFixed: { reopened: false, words: "Still jams.", at } };
    expect(cardLine(ticket(mine), "team", facts)).toEqual({
      text: "The customer said no on ",
      day: at,
      after: ".",
      tick: false,
      messageAt: at,
    });
  });

  it("tells the customer who said no that they will be asked again, without their words", () => {
    const facts = { ...nothing, notFixed: { reopened: false, words: "Still jams.", at } };
    const line = cardLine(ticket(mine), "customer", facts);
    expect(words(line)).toBe("You said no on 19 Nov 2026. The team will ask you again.");
    expect(words(line)).not.toContain("Still jams.");
  });

  it("tells the team the customer reopened it, linked to their message", () => {
    const facts = { ...nothing, notFixed: { reopened: true, words: "Again.", at } };
    expect(cardLine(ticket(mine), "team", facts)).toEqual({
      text: "The customer reopened it on ",
      day: at,
      after: ".",
      tick: false,
      messageAt: at,
    });
    // The customer's own ticket is simply open again, which needs no line.
    expect(cardLine(ticket(mine), "customer", facts)).toBeNull();
  });

  it("shows the tick with Customer confirmed and the day, to everyone, after their Yes", () => {
    const resolved = ticket({ status: "resolved" });
    const facts = { ...nothing, confirmed: at };
    for (const viewer of ["team", "admin", "customer"] as const) {
      expect(cardLine(resolved, viewer, facts)).toEqual({
        text: "Customer confirmed it is fixed. ",
        day: at,
        after: "",
        tick: true,
        messageAt: null,
      });
    }
  });

  it("names the team's reason, who and when, and that the customer did not confirm it", () => {
    const resolved = ticket({
      status: "resolved",
      resolution: {
        by: "team",
        label: "Resolved by the team: Cannot reproduce",
        reason: "cannot_reproduce",
        reason_label: "Cannot reproduce",
        note: null,
        duplicate_of: null,
        resolved_by_name: "Demo Team Member",
        at,
      },
    });
    const line = cardLine(resolved, "team", nothing);
    expect(words(line)).toBe(
      "Resolved by the team: Cannot reproduce. Demo Team Member, 19 Nov 2026. Not confirmed by the customer.",
    );
    expect(line).toMatchObject({ day: at, tick: false, messageAt: null });
  });

  it("tells the customer what the team said, and that they have not confirmed it", () => {
    const byTeam = (reason: "fixed_no_reply" | "wont_fix", reasonLabel: string) =>
      ticket({
        status: "resolved",
        resolution: {
          by: "team",
          label: `Resolved by the team: ${reasonLabel}`,
          reason,
          reason_label: reasonLabel,
          note: reason === "wont_fix" ? "Works as designed." : null,
          duplicate_of: null,
          resolved_by_name: "Demo Team Member",
          at,
        },
      });
    const fixed = cardLine(
      byTeam("fixed_no_reply", "Fixed. Not customer-confirmed."),
      "customer",
      nothing,
    );
    expect(words(fixed)).toBe("The team says it is fixed. You have not confirmed it.");
    expect(fixed?.tick).toBe(false);
    expect(words(cardLine(byTeam("wont_fix", "Won't fix"), "customer", nothing))).toBe(
      "Resolved by the team: Won't fix (Works as designed). You have not confirmed it.",
    );
    // "Fixed" is said once on the team's line too, not with its label's own caveat.
    expect(
      words(cardLine(byTeam("fixed_no_reply", "Fixed. Not customer-confirmed."), "team", nothing)),
    ).toBe(
      "Resolved by the team: Fixed. Demo Team Member, 19 Nov 2026. Not confirmed by the customer.",
    );
  });

  it("says nothing to the customer on their own New or In Progress ticket", () => {
    expect(cardLine(ticket(), "customer", nothing)).toBeNull();
    expect(cardLine(ticket(mine), "customer", nothing)).toBeNull();
  });

  it("says when an archived ticket was archived, to the team, before anything else", () => {
    const archived = ticket({ ...mine, archived_at: at, ready_at: at });
    expect(words(cardLine(archived, "admin", nothing))).toBe(
      "Archived on 19 Nov 2026. Hidden from the lists until restored.",
    );
    expect(cardLine(archived, "customer", nothing)).toBeNull();
  });
});

describe("a day on the card", () => {
  it("is the day alone, in UTC, as the text a page without scripts shows", () => {
    expect(formatDay("2026-11-17T23:56:00.000Z")).toBe("17 Nov 2026");
  });

  it("is kept apart from the words, so the page can show it in the visitor's time zone", () => {
    const line = cardLine(ticket({ ...mine, ready_at: at }), "team", nothing);
    expect(line).toMatchObject({
      text: "Waiting for the customer's answer. Asked ",
      day: at,
      after: ".",
    });
  });
});

describe("a note on the team's resolution", () => {
  it("loses its own last full stop inside the brackets, so the line does not read .).", () => {
    const resolved = ticket({
      status: "resolved",
      resolution: {
        by: "team",
        label: "Resolved by the team: Other",
        reason: "other",
        reason_label: "Other",
        note: "Out of scope. See the policy.",
        duplicate_of: null,
        resolved_by_name: "Demo Team Member",
        at,
      },
    });
    expect(words(cardLine(resolved, "team", nothing))).toBe(
      "Resolved by the team: Other (Out of scope. See the policy). Demo Team Member, 19 Nov 2026. Not confirmed by the customer.",
    );
    expect(words(cardLine(resolved, "customer", nothing))).toBe(
      "Resolved by the team: Other (Out of scope. See the policy). You have not confirmed it.",
    );
  });
});
