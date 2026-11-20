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

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/**
 * Writes one sample that was filed, taken, started and resolved weeks ago, with each step's
 * History entry at its own past time. The ticket service takes its times from the clock, and a
 * history entry never changes once written, so these samples are written here with their times
 * instead. Only the demo's seed calls it, before it records what it seeded. logEvent is the
 * service's own writer of history entries. Returns the ticket's key.
 */
export function writePastSample(
  db: Db,
  prefix: string,
  logEvent: (event: repository.NewEvent) => void,
  sample: PastSample,
): string {
  const resolvedAt = Date.now() - sample.resolvedDaysAgo * DAY;
  // Filed two days before it was resolved, taken and started the day after it was filed.
  const filed = new Date(resolvedAt - 2 * DAY).toISOString();
  const started = new Date(resolvedAt - DAY).toISOString();
  const resolved = new Date(resolvedAt).toISOString();
  const team = sample.team;

  return db.transaction(() => {
    const id = repository.insertTicket(db, {
      title: sample.title,
      description: sample.description,
      whereUrl: null,
      fixCheck: sample.fixCheck,
      createdBy: sample.filer.id,
      now: filed,
    });
    const event = (actor: Actor, type: string, data: object, now: string) =>
      logEvent({ ticketId: id, actor: actor.id, actorKind: "person", type, data, now });
    event(sample.filer, "created", { status: "new" }, filed);

    repository.updateTicketOwner(db, id, team.id, team.name, started);
    event(team, "owner_changed", { from: null, to: team.name }, started);
    repository.updateTicketStatus(db, id, "in_progress", started);
    event(team, "status_changed", { from: "new", to: "in_progress" }, started);

    const resolution = {
      reason: sample.reason,
      note: sample.note,
      duplicateOf: null,
      by: team.id,
      byName: team.name,
    };
    repository.resolveByTeam(db, id, resolution, resolved);
    const said = { reason: sample.reason, note: sample.note, duplicate_of: null };
    event(team, "resolved_by_team", { ...said, from: "in_progress" }, resolved);

    // The customer's Yes, two hours later, clears the team's reason, as confirmFix does.
    if (sample.confirmed) {
      const confirmed = new Date(resolvedAt + 2 * HOUR).toISOString();
      repository.updateTicketStatus(db, id, "resolved", confirmed);
      event(sample.filer, "customer_answered", { fixed: true }, confirmed);
    }
    return buildKey(prefix, id);
  })();
}
