import { describe, expect, it } from "vitest";
import { composeNotice, EXCERPT_MOST, SUBJECT_MOST } from "../src/server/notify/compose.js";

// The words of a notice come from fixed templates. The subject is one line of sensible length,
// whatever the ticket's title holds.

const base = {
  kind: "team_replied" as const,
  ticketKey: "SUP-4",
  title: "Printer jams",
  siteUrl: "https://desk.test",
  recipientName: "Customer One",
  actorName: "Team Member",
  publicText: "Looking at it now.",
};

describe("a notice's subject", () => {
  it("names the ticket's key and title", () => {
    expect(composeNotice(base).subject).toBe("[SUP-4] New reply: Printer jams");
  });

  it("is always one line, whatever the title holds", () => {
    const title = "Printer\r\njams\nBcc: someone\u2028again\ttoday\u0000";
    const { subject } = composeNotice({ ...base, title });
    expect(subject).toBe("[SUP-4] New reply: Printer jams Bcc: someone again today");
    expect(subject).not.toMatch(/[\r\n\u2028\u2029]|\p{Cc}/u);
  });

  it("is cut to a sensible length", () => {
    const { subject } = composeNotice({ ...base, title: "A very long title ".repeat(20) });
    expect(Array.from(subject).length).toBeLessThanOrEqual(SUBJECT_MOST);
    expect(subject.endsWith("...")).toBe(true);
  });
});

describe("a notice's body", () => {
  it("says who did what, links to the ticket and ends with why", () => {
    const lines = composeNotice(base).body.split("\n");
    expect(lines[0]).toBe("Hello Customer One,");
    expect(lines).toContain('Team Member replied on ticket SUP-4, "Printer jams":');
    expect(lines).toContain('"Looking at it now."');
    expect(lines).toContain("Open the ticket: https://desk.test/tickets/SUP-4");
    expect(lines.at(-1)).toBe("You got this email because you filed this ticket.");
  });

  it("quotes only a short part of a long reply", () => {
    const { body } = composeNotice({ ...base, publicText: "word ".repeat(400) });
    const quote = body.split("\n").find((line) => line.startsWith('"'))!;
    expect(Array.from(quote).length).toBeLessThanOrEqual(EXCERPT_MOST + 2);
    expect(quote.endsWith('..."')).toBe(true);
  });

  it("asks the customer the question, with the page to check and the link to answer", () => {
    const { body } = composeNotice({
      ...base,
      kind: "asked_to_check",
      publicText: null,
      tryUrl: "https://example.com/try",
    });
    expect(body).toContain("asks you:\n\nDid this fix it?");
    expect(body).toContain("Check it here: https://example.com/try");
    expect(body).toContain("Answer Yes or No on the ticket: https://desk.test/tickets/SUP-4");
    // One link to the ticket, the one that answers.
    expect(body.split("https://desk.test/tickets/SUP-4").length).toBe(2);
  });

  it("tells the new owner why they got it", () => {
    const { subject, body } = composeNotice({ ...base, kind: "handed_to_you", publicText: null });
    expect(subject).toBe("[SUP-4] Handed to you: Printer jams");
    expect(body.split("\n").at(-1)).toBe(
      "You got this email because the ticket was handed to you.",
    );
  });
});
