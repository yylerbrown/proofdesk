import type { Request, Response } from "express";

// After a form saves something, the browser is sent to another page. This says on that page
// what was saved. The cookie holds only one of the words below, never text from the form, so
// nobody can make the page show a message of their own. It lives a minute and is read once.

export const SAVED_MESSAGES = {
  filed: "Ticket filed. The team will see it in their list.",
  edited: "Changes saved.",
  status: "Status changed.",
  reply: "Reply sent.",
  note: "Internal note added. The customer does not see it.",
  taken: "You own this ticket now.",
  started: "You own this ticket, and it is in progress.",
  handedOff: "Handed off. The new owner has it now.",
  adopted: "These are now your check, in your own name.",
  withdrawn: "Question withdrawn. You can ask the customer again when you are ready.",
  agentGiven: "Handed to the assistant. It can work on this ticket only.",
  agentEnded: "The assistant has stopped working on this ticket.",
  reopened: "Reopened. The team has your words.",
  released: "Ticket released. It has no owner now.",
  restored: "Ticket restored.",
  archived: "Ticket archived.",
  check: "Agreed check saved.",
  evidence: "Evidence attached. It is shown as reported by you; it does not resolve the ticket.",
  link: "Change link saved.",
  ready: "The customer has been asked to check the fix.",
  fixed: "Thank you. The ticket is resolved.",
  notFixed: "Thank you. The ticket is back with the team.",
  specAccepted: "Test spec accepted as the way to test.",
  specDiscarded: "Test spec discarded.",
} as const;

export type SavedKey = keyof typeof SAVED_MESSAGES;

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
