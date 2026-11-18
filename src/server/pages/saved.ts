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
  released: "Ticket released. It has no owner now.",
  restored: "Ticket restored.",
  archived: "Ticket archived.",
  check: "Agreed check saved.",
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
