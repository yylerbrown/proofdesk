import type { NoticeKind } from "./rules.js";

// The words of each notice, from fixed templates. A notice carries the ticket's key and title,
// who did what, a link to the ticket and why this person got it. A reply notice quotes a short
// part of the public reply only. No notice ever carries the text of an internal note: nothing
// here is given one.

/** The longest subject, in characters. Longer ones are cut and end with three dots. */
export const SUBJECT_MOST = 100;

/** The longest part of a reply quoted in a notice, in characters. */
export const EXCERPT_MOST = 300;

/** Everything a notice may say. Every text here is one the recipient may already see. */
export type NoticeInput = {
  kind: NoticeKind;
  ticketKey: string;
  title: string;
  /** The site's public address, without a slash at the end. */
  siteUrl: string;
  recipientName: string;
  /** Who did it, by display name. */
  actorName: string;
  /** For a reply, a No or a reopen: the public words the customer or team wrote. */
  publicText?: string | null;
  /** For "Did this fix it?": the page where the customer can check the fix. */
  tryUrl?: string | null;
  /** For a team resolution: the reason, in plain words. */
  resolvedReason?: string | null;
};

export type ComposedNotice = { subject: string; body: string };

/** What each kind of notice says at the start of its subject. */
const SUBJECT_LEADS: Record<NoticeKind, string> = {
  asked_to_check: "Did this fix it?",
  team_replied: "New reply:",
  resolved_by_team: "Resolved:",
  handed_to_you: "Handed to you:",
  customer_said_no: "Not fixed yet:",
  customer_replied: "Customer replied:",
  customer_reopened: "Reopened:",
};

/** Builds the subject and plain-text body of one notice. */
export function composeNotice(input: NoticeInput): ComposedNotice {
  const title = oneLine(input.title);
  const link = `${input.siteUrl}/tickets/${input.ticketKey}`;
  const subject = cut(`[${input.ticketKey}] ${SUBJECT_LEADS[input.kind]} ${title}`, SUBJECT_MOST);

  const lines: string[] = [`Hello ${oneLine(input.recipientName)},`, ""];
  lines.push(...whatHappened(input, title, link));
  // "Did this fix it?" already ends with the link to answer it.
  if (input.kind !== "asked_to_check") lines.push("", `Open the ticket: ${link}`);
  lines.push("", whyYouGotThis(input.kind));
  return { subject, body: lines.join("\n") };
}

/** The middle of a notice: who did what, and what the recipient can do about it. */
function whatHappened(input: NoticeInput, title: string, link: string): string[] {
  const who = oneLine(input.actorName);
  const about = `ticket ${input.ticketKey}, "${title}"`;
  const quoted = excerpt(input.publicText ?? "");
  switch (input.kind) {
    case "asked_to_check": {
      const lines = [`${who} worked on ${about}, and asks you:`, "", "Did this fix it?"];
      if (input.tryUrl) lines.push("", `Check it here: ${oneLine(input.tryUrl)}`);
      lines.push("", `Answer Yes or No on the ticket: ${link}`);
      return lines;
    }
    case "team_replied":
      return [`${who} replied on ${about}:`, "", quoted];
    case "resolved_by_team": {
      const reason = input.resolvedReason ? ` The reason: ${oneLine(input.resolvedReason)}.` : "";
      return [
        `${who} resolved ${about}.${reason}`,
        "",
        "If it is still happening, you can reopen it from the ticket.",
      ];
    }
    case "handed_to_you":
      return [`${who} handed ${about} to you. It is yours now.`];
    case "customer_said_no":
      return [`${who} says ${about} is not fixed yet:`, "", quoted];
    case "customer_replied":
      return [`${who} replied on ${about}:`, "", quoted];
    case "customer_reopened":
      return [`${who} reopened ${about}. It is still happening:`, "", quoted];
  }
}

/** The last line: why this person got the notice. */
function whyYouGotThis(kind: NoticeKind): string {
  if (kind === "handed_to_you") return "You got this email because the ticket was handed to you.";
  if (kind === "customer_said_no" || kind === "customer_replied" || kind === "customer_reopened") {
    return "You got this email because you own this ticket.";
  }
  return "You got this email because you filed this ticket.";
}

/** The text on one line: every run of spaces, tabs and line breaks becomes one space. */
function oneLine(text: string): string {
  // \s also matches the Unicode line and paragraph separators. Control characters go too.
  return text
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A short part of a public reply, on one line, quoted. */
function excerpt(text: string): string {
  return `"${cut(oneLine(text), EXCERPT_MOST)}"`;
}

/** Cuts text to at most this many characters, ending with three dots when it was cut. */
function cut(text: string, most: number): string {
  // Counted by character, so a cut never splits a character in two.
  const characters = Array.from(text);
  if (characters.length <= most) return text;
  return `${characters
    .slice(0, most - 3)
    .join("")
    .trimEnd()}...`;
}
