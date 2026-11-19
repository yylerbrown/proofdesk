import type { Db } from "../db.js";
import { createHistory } from "./history.js";
import * as repository from "./repository.js";

// What happens to tickets when an assistant connection ends.

/** Why the hand-off ended, as the ticket's history says it. */
export const CONNECTION_ENDED = "its connection ended";

/**
 * Ends every hand-off to an assistant connection that has ended, whether an admin revoked it or
 * a role change did, with a history entry on each ticket, so no ticket waits on an assistant
 * that can never answer. endedBy is the id of the person who ended the connection. Call it right
 * after ending connections. Returns how many hand-offs it ended.
 */
export function endHandoffsToEndedConnections(db: Db, endedBy: string): number {
  // A history entry is never refused for the budget here: the connection has ended either way.
  const { logEvent } = createHistory(db, {});
  const end = db.transaction((): number => {
    const now = new Date().toISOString();
    let ended = 0;
    for (const ticketId of repository.ticketsHandedToEndedConnections(db)) {
      const connection = repository.endHandoff(db, ticketId, CONNECTION_ENDED, now);
      if (connection === undefined) continue;
      logEvent({
        ticketId,
        actor: endedBy,
        actorKind: "person",
        type: "agent_handoff_ended",
        data: { connection, reason: CONNECTION_ENDED },
        now,
      });
      ended += 1;
    }
    return ended;
  });
  return end();
}
