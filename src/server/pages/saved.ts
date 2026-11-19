import type { Request, Response } from "express";

// After a form saves something, the browser is sent to another page. This says on that page
// what was saved. The cookie holds only one of the words below, never text from the form, so
// nobody can make the page show a message of their own. It lives a minute and is read once.

// What happens after filing, said by the receipt with or without the ticket's key.
const FILED_NEXT = "The support team has it now; come back to this page for updates.";

export const SAVED_MESSAGES = {
  // The ticket page puts the key in this line; see filedMessage below.
  filed: `Ticket filed. ${FILED_NEXT}`,
  alreadyFiled: "You already filed this form, so nothing new was filed. This is that ticket.",
  edited: "Changes saved.",
  status: "Status changed.",
  returnedToNew: "Back to New and unassigned. Anyone on the team can take it.",
  reply: "Reply sent.",
  note: "Internal note added. The customer does not see it.",
  taken: "Assigned to you.",
  started: "You own this ticket, and it is in progress.",
  handedOff: "Assigned. The new owner has it now.",
  adopted: "These are now your check, in your own name.",
  checkChosen: "Saved. The team will check the fix against it.",
  withdrawn: "Question withdrawn. You can ask the customer again when you are ready.",
  agentGiven: "Handed to the assistant. It can work on this ticket only.",
  agentEnded: "The assistant has stopped working on this ticket.",
  reopenedByTeam: "Reopened, with your reason.",
  resolvedByTeam: "Resolved, with your reason. The customer sees it and can reopen it.",
  markedFixed: "Marked fixed. The customer has been told.",
  released: "Unassigned. Anyone on the team can take it.",
  restored: "Ticket restored.",
  archived: "Ticket archived.",
  check: "Team's check saved.",
  evidence: "Evidence added. It is shown as reported by you; it does not resolve the ticket.",
  link: "Change link saved.",
  ready: "Asked the customer: Did this fix it?",
  fixed: "Thank you. The ticket is resolved.",
  // After the customer's No, or their reopening a resolved ticket.
  notFixed: "Thank you. The ticket is back with the team.",
  specAccepted: "Test accepted. It is the agreed test now.",
  specDiscarded: "Suggested test discarded.",
} as const;

export type SavedKey = keyof typeof SAVED_MESSAGES;

/**
 * The receipt after filing, on the new ticket's own page: it names the ticket, so the person
 * knows which one is theirs, and says what happens next. It says nothing about email, which
 * the real site may also send.
 */
export function filedMessage(key: string): string {
  return `Ticket ${key} filed. ${FILED_NEXT}`;
}

const COOKIE = "saved";

/** Remembers what was saved, for the next page this browser opens. */
export function rememberSaved(res: Response, key: SavedKey): void {
  res.cookie(COOKIE, key, { httpOnly: true, sameSite: "lax", maxAge: 60_000, path: "/" });
}

/** The message for what was just saved, once: reading it clears it. Null when there is none. */
export function takeSaved(req: Request, res: Response): string | null {
  const key: unknown = req.cookies?.[COOKIE];
  if (key === undefined) return null;
  res.clearCookie(COOKIE, { path: "/" });
  return typeof key === "string" && Object.hasOwn(SAVED_MESSAGES, key)
    ? SAVED_MESSAGES[key as SavedKey]
    : null;
}

const PROBLEM_COOKIE = "problem";

/**
 * Remembers why a ticket action was refused, for the ticket page the browser is sent back to.
 * Only the server sets this cookie, from its own messages; it lives a minute and is read once.
 */
export function rememberProblem(res: Response, message: string): void {
  res.cookie(PROBLEM_COOKIE, message.slice(0, 300), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60_000,
    path: "/",
  });
}

/** Why the last ticket action was refused, once: reading it clears it. Null when there is none. */
export function takeProblem(req: Request, res: Response): string | null {
  const message: unknown = req.cookies?.[PROBLEM_COOKIE];
  if (message === undefined) return null;
  res.clearCookie(PROBLEM_COOKIE, { path: "/" });
  return typeof message === "string" && message.length > 0 ? message : null;
}
