import type { Request, Response } from "express";
import { z } from "zod";
import type { BulkOutcome } from "../tickets/bulk.js";
import { STATUS_LABELS } from "./format.js";

// After the ticket list changes many tickets at once, the browser is sent back to the list,
// which then says in one line what happened: how many moved, and which were not changed and why.
// The cookie holds only the change, a count and each unchanged ticket's key with its error code,
// never text from the form or a message, so nobody can make the list show words of their own.
// The words come from the table below. It lives a minute and is read once.

const COOKIE = "bulk_outcome";

const rememberedSchema = z.object({
  status: z.enum(["new", "in_progress", "resolved"]).optional(),
  reason: z.string().max(40).optional(),
  owner: z.string().max(200).optional(),
  changed: z.number().int().min(0),
  // Each error code, with the keys of the tickets it kept as they were.
  kept: z.record(z.string().max(40), z.array(z.string().max(20))),
});
type Remembered = z.infer<typeof rememberedSchema>;

/** Remembers what a change to many tickets did, for the list the browser opens next. */
export function rememberBulkOutcome(res: Response, outcome: BulkOutcome): void {
  const kept: Record<string, string[]> = {};
  for (const item of outcome.not_changed) {
    kept[item.code] = [...(kept[item.code] ?? []), item.key];
  }
  const { change } = outcome;
  const remembered: Remembered =
    "status" in change
      ? { status: change.status, reason: change.reason, changed: outcome.changed.length, kept }
      : { owner: change.owner, changed: outcome.changed.length, kept };
  res.cookie(COOKIE, JSON.stringify(remembered), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60_000,
    path: "/",
  });
}

/**
 * The line for what the last change to many tickets did, once: reading it clears it. Null when
 * there is none. nameOf gives a team member's name, for "assigned to".
 */
export function takeBulkOutcome(
  req: Request,
  res: Response,
  nameOf: (id: string) => string | undefined,
): string | null {
  const raw: unknown = req.cookies?.[COOKIE];
  if (raw === undefined) return null;
  res.clearCookie(COOKIE, { path: "/" });
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const checked = rememberedSchema.safeParse(parsed);
  return checked.success ? bulkOutcomeLine(checked.data, nameOf) : null;
}

/** "7 moved to Resolved. 2 were not changed: SUP-4 (only its owner ...); SUP-9 (already resolved)." */
export function bulkOutcomeLine(
  outcome: Remembered,
  nameOf: (id: string) => string | undefined,
): string {
  const parts: string[] = [];
  if (outcome.changed > 0) parts.push(changedWords(outcome, nameOf));
  const groups = Object.entries(outcome.kept).filter(([, keys]) => keys.length > 0);
  const keptCount = groups.reduce((sum, [, keys]) => sum + keys.length, 0);
  if (keptCount > 0) {
    const list = groups
      .map(([code, keys]) => `${keys.join(", ")} (${whyKept(outcome, code)})`)
      .join("; ");
    parts.push(`${keptCount} ${keptCount === 1 ? "was" : "were"} not changed: ${list}.`);
  }
  return parts.join(" ");
}

function changedWords(outcome: Remembered, nameOf: (id: string) => string | undefined): string {
  const count = outcome.changed;
  if (outcome.status !== undefined) return `${count} moved to ${STATUS_LABELS[outcome.status]}.`;
  if (outcome.owner === "me") return `${count} assigned to you.`;
  if (outcome.owner === "nobody") {
    return count === 1 ? "1 now has no owner." : `${count} now have no owner.`;
  }
  return `${count} assigned to ${nameOf(outcome.owner ?? "") ?? "a team member"}.`;
}

/**
 * Why a ticket was left as it was, in a few words, from the code the same change on its own
 * page answers. Its page gives the full reason.
 */
function whyKept(outcome: Remembered, code: string): string {
  const { status, owner } = outcome;
  switch (code) {
    case "nothing_to_change":
      if (status !== undefined) return `already ${STATUS_LABELS[status]}`;
      if (owner === "me") return "already yours";
      if (owner === "nobody") return "nobody owns it";
      return "already theirs";
    case "not_open":
      return status === "resolved" ? "already resolved" : "resolved";
    case "only_filer_reopens":
      return "resolved: reopen it on its own page, with a reason";
    case "not_owner":
      if (status === "resolved") return "only its owner or an admin can resolve it";
      if (status === "new") return "only its owner or an admin can return it to New";
      if (status === "in_progress") return "only its owner can start work on it";
      if (owner === "nobody") return "only its owner can let it go";
      return "only its owner or an admin can hand it over";
    case "keeps_owner":
      return "in progress, so it keeps an owner";
    case "already_owned":
      return "someone else owns it";
    case "ticket_archived":
      return "archived";
    case "ticket_not_found":
      return "no such ticket";
    case "validation_error":
      return outcome.reason === "fixed_no_reply"
        ? "its customer said it is not fixed"
        : "that reason does not fit it";
    default:
      return "not allowed";
  }
}
