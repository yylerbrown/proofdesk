import type { Actor } from "./actor.js";
import type { Db } from "./db.js";
import { buildKey } from "./tickets/keys.js";
import * as repository from "./tickets/repository.js";
import type { ResolveReason } from "./tickets/schemas.js";

/**
 * A demo sample resolved by the team weeks ago. When confirmed is true, its filer then
 * confirmed the fix, so it shows as confirmed by the customer.
 */
export type PastSample = {
  title: string;
  description: string;
  fixCheck: string;
  filer: Actor;
  team: Actor;
  resolvedDaysAgo: number;
  reason: ResolveReason;
  note: string | null;
  confirmed: boolean;
};

/**
 * A demo ticket with the time of each step it went through. A ticket that was never taken has
 * no `taken`, and one that was never resolved has no `resolved`. When `resolved.confirmedAt` is
 * set, the filer confirmed the fix at that time, which clears the team's reason.
 */
export type DatedSample = {
  title: string;
  description: string;
  fixCheck: string | null;
  filer: Actor;
  filedAt: string;
  taken?: { by: Actor; at: string };
  resolved?: { reason: ResolveReason; note: string | null; at: string; confirmedAt: string | null };
};

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/**
 * Writes one sample that was filed, taken, started and resolved weeks ago, with each step's
 * History entry at its own past time. Only the demo's seed calls it, before it records what it
 * seeded. Returns the ticket's key.
 */
export function writePastSample(
  db: Db,
  prefix: string,
  logEvent: (event: repository.NewEvent) => void,
  sample: PastSample,
): string {
  const resolvedAt = Date.now() - sample.resolvedDaysAgo * DAY;
  // Filed two days before it was resolved, taken and started the day after it was filed. The
  // customer's Yes, when there is one, comes two hours after it was resolved.
  return writeDatedSample(db, prefix, logEvent, {
    title: sample.title,
    description: sample.description,
    fixCheck: sample.fixCheck,
    filer: sample.filer,
    filedAt: new Date(resolvedAt - 2 * DAY).toISOString(),
    taken: { by: sample.team, at: new Date(resolvedAt - DAY).toISOString() },
    resolved: {
      reason: sample.reason,
      note: sample.note,
      at: new Date(resolvedAt).toISOString(),
      confirmedAt: sample.confirmed ? new Date(resolvedAt + 2 * HOUR).toISOString() : null,
    },
  });
}

/**
 * Writes one demo ticket with each step's History entry at its own past time. The ticket
 * service takes its times from the clock, and a history entry never changes once written, so
 * the demo's dated samples are written here with their times instead. logEvent is the
 * service's own writer of history entries. Returns the ticket's key.
 */
export function writeDatedSample(
  db: Db,
  prefix: string,
  logEvent: (event: repository.NewEvent) => void,
  sample: DatedSample,
): string {
  return db.transaction(() => {
    const id = repository.insertTicket(db, {
      title: sample.title,
      description: sample.description,
      whereUrl: null,
      fixCheck: sample.fixCheck,
      createdBy: sample.filer.id,
      now: sample.filedAt,
    });
    const event = (actor: Actor, type: string, data: object, now: string) =>
      logEvent({ ticketId: id, actor: actor.id, actorKind: "person", type, data, now });
    event(sample.filer, "created", { status: "new" }, sample.filedAt);

    const taken = sample.taken;
    if (taken === undefined) return buildKey(prefix, id);
    const team = taken.by;
    repository.updateTicketOwner(db, id, team.id, team.name, taken.at);
    event(team, "owner_changed", { from: null, to: team.name }, taken.at);
    repository.updateTicketStatus(db, id, "in_progress", taken.at);
    event(team, "status_changed", { from: "new", to: "in_progress" }, taken.at);

    const resolved = sample.resolved;
    if (resolved === undefined) return buildKey(prefix, id);
    const resolution = {
      reason: resolved.reason,
      note: resolved.note,
      duplicateOf: null,
      by: team.id,
      byName: team.name,
    };
    repository.resolveByTeam(db, id, resolution, resolved.at);
    const said = { reason: resolved.reason, note: resolved.note, duplicate_of: null };
    event(team, "resolved_by_team", { ...said, from: "in_progress" }, resolved.at);

    // The customer's Yes clears the team's reason, as confirmFix does.
    if (resolved.confirmedAt !== null) {
      repository.updateTicketStatus(db, id, "resolved", resolved.confirmedAt);
      event(sample.filer, "customer_answered", { fixed: true }, resolved.confirmedAt);
    }
    return buildKey(prefix, id);
  })();
}
