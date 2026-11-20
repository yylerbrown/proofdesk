import { describe, expect, it } from "vitest";
import { cardLine, formatDay, type CardFacts, type CardLine } from "../src/server/pages/format.js";
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
const words = (line: CardLine | null) =>
  line === null ? null : `${line.text}${line.day === null ? "" : formatDay(line.day)}${line.after}`;

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
      quote: null,
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

  it("tells the team the customer says it is not fixed, quoting their words", () => {
    const facts = { ...nothing, notFixed: { reopened: false, words: "Still jams.", at } };
    expect(cardLine(ticket(mine), "team", facts)).toEqual({
      text: "The customer said it is not fixed on ",
      day: at,
      after: ":",
      tick: false,
      messageAt: null,
      quote: "Still jams.",
    });
  });

  it("shortens a long No at a word, with an ellipsis, past about 140 characters", () => {
    const long = `${"The export still fails ".repeat(10)}at the end.`;
    const facts = { ...nothing, notFixed: { reopened: false, words: long, at } };
    const quote = cardLine(ticket(mine), "team", facts)!.quote!;
    expect(quote.length).toBeLessThanOrEqual(141);
    expect(quote.endsWith("fails\u2026")).toBe(true);
    expect(long.startsWith(quote.slice(0, -1))).toBe(true);
  });

  it("tells the customer who said no what they said, without their words", () => {
    const facts = { ...nothing, notFixed: { reopened: false, words: "Still jams.", at } };
    const line = cardLine(ticket(mine), "customer", facts);
    expect(words(line)).toBe("You said it is not fixed on 19 Nov 2026.");
    expect(words(line)).not.toContain("Still jams.");
  });

  it("says a reopening with the same words as a No, quoting their reason", () => {
    const facts = { ...nothing, notFixed: { reopened: true, words: "Again.", at } };
    expect(cardLine(ticket(mine), "team", facts)).toEqual({
      text: "The customer said it is not fixed on ",
      day: at,
      after: ":",
      tick: false,
      messageAt: null,
      quote: "Again.",
    });
    expect(words(cardLine(ticket(mine), "customer", facts))).toBe(
      "You said it is not fixed on 19 Nov 2026.",
    );
  });

  it("shows the team the tick with Customer confirmed and the day, after the customer's Yes", () => {
    const resolved = ticket({ status: "resolved" });
    const facts = { ...nothing, confirmed: at };
    // The customer reads the day in the line under the title instead.
    expect(cardLine(resolved, "customer", facts)).toBeNull();
    for (const viewer of ["team", "admin"] as const) {
      expect(cardLine(resolved, viewer, facts)).toEqual({
        text: "Customer confirmed on ",
        day: at,
        after: ".",
        tick: true,
        messageAt: null,
        quote: null,
      });
    }
  });

  it("names the team's reason, who and when, then that the customer can reopen it", () => {
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
      "Resolved by the team: Cannot reproduce. Demo Team Member, 19 Nov 2026. The customer can reopen it.",
    );
    expect(line).toMatchObject({ day: at, tick: false, messageAt: null });
  });

  it("tells the customer what the team said, and leaves Fixed to the question", () => {
    const byTeam = (
      reason: "fixed_no_reply" | "wont_fix",
      reasonLabel: string,
      note: string | null = reason === "wont_fix" ? "Works as designed." : null,
    ) =>
      ticket({
        status: "resolved",
        resolution: {
          by: "team",
          label: `Resolved by the team: ${reasonLabel}`,
          reason,
          reason_label: reasonLabel,
          note,
          duplicate_of: null,
          resolved_by_name: "Demo Team Member",
          at,
        },
      });
    // Marked fixed, the customer's page asks "Did this fix it?" in place of a line.
    expect(
      cardLine(byTeam("fixed_no_reply", "Fixed. Not customer-confirmed."), "customer", nothing),
    ).toBeNull();
    expect(words(cardLine(byTeam("wont_fix", "Won't fix"), "customer", nothing))).toBe(
      "Won't fix (Works as designed). You have not confirmed it.",
    );
    // The team reads the reason as it was chosen, where it is fixed, who and when.
    expect(
      words(cardLine(byTeam("fixed_no_reply", "Fixed. Not customer-confirmed."), "team", nothing)),
    ).toBe(
      "Resolved by the team: Fixed. Demo Team Member, 19 Nov 2026. The customer has not confirmed it.",
    );
    expect(
      words(
        cardLine(
          byTeam("fixed_no_reply", "Fixed. Not customer-confirmed.", "version 4.2.1"),
          "team",
          nothing,
        ),
      ),
    ).toBe(
      "Resolved by the team: Fixed. Fixed in: version 4.2.1. Demo Team Member, 19 Nov 2026. The customer has not confirmed it.",
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
      "Resolved by the team: Other (Out of scope. See the policy). Demo Team Member, 19 Nov 2026. The customer can reopen it.",
    );
    expect(words(cardLine(resolved, "customer", nothing))).toBe(
      "Other (Out of scope. See the policy). You have not confirmed it.",
    );
  });
});
