import type { Db } from "../db.js";
import { createAccess } from "./access.js";
import { createHistory } from "./history.js";
import { createPublicFields } from "./public-fields.js";
import type { Budget } from "./types.js";

/**
 * The pieces every part of the ticket service uses: the database, the key prefix, the budget,
 * and the helpers that need them. Each part takes this object and picks what it needs.
 */
export function createShared(db: Db, prefix: string, budget: Budget) {
  return {
    db,
    prefix,
    budget,
    // access.ts: idFromKey, requireRow, visibleScope
    ...createAccess(db, prefix),
    // history.ts: logEvent, log, setOwner, endAgent, withdrawQuestion
    ...createHistory(db, budget),
    // public-fields.ts: toTicket, toEvent, toEvidence, toSpec
    ...createPublicFields(db, prefix),
  };
}

export type Shared = ReturnType<typeof createShared>;
