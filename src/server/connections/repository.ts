import type { Db } from "../db.js";

// All SQL for agent connections.

export type ConnectionRow = {
  id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string; // JSON array
  issued_by: string;
  demo: number;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

export type NewConnection = {
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  issuedBy: string;
  demo: boolean;
  now: string;
  expiresAt: string | null;
};

export function insertConnection(db: Db, c: NewConnection): number {
  const result = db
    .prepare(
      `INSERT INTO agent_connections
         (name, key_prefix, key_hash, scopes, issued_by, demo, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.name,
      c.keyPrefix,
      c.keyHash,
      JSON.stringify(c.scopes),
      c.issuedBy,
      c.demo ? 1 : 0,
      c.now,
      c.expiresAt,
    );
  return Number(result.lastInsertRowid);
}

export function findByPrefix(db: Db, prefix: string): ConnectionRow | undefined {
  return db.prepare("SELECT * FROM agent_connections WHERE key_prefix = ?").get(prefix) as
    ConnectionRow | undefined;
}

export function findById(db: Db, id: number): ConnectionRow | undefined {
  return db.prepare("SELECT * FROM agent_connections WHERE id = ?").get(id) as
    ConnectionRow | undefined;
}

/** The connections people issued, newest first. Demo connections are listed apart. */
export function listIssued(db: Db): ConnectionRow[] {
  return db
    .prepare("SELECT * FROM agent_connections WHERE demo = 0 ORDER BY id DESC LIMIT 200")
    .all() as ConnectionRow[];
}

/** How many demo connections can still be used right now. */
export function countLiveDemo(db: Db, now: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM agent_connections WHERE demo = 1 AND revoked_at IS NULL AND expires_at > ?",
    )
    .get(now) as { n: number };
  return row.n;
}

/**
 * Revokes this many live demo connections, those used longest ago first. One never used
 * counts from when it was issued.
 */
export function revokeLeastRecentlyUsedDemo(db: Db, now: string, count: number): void {
  db.prepare(
    `UPDATE agent_connections SET revoked_at = ?
     WHERE id IN (SELECT id FROM agent_connections
                  WHERE demo = 1 AND revoked_at IS NULL AND expires_at > ?
                  ORDER BY COALESCE(last_used_at, created_at), id
                  LIMIT ?)`,
  ).run(now, now, count);
}

export type ActivityRow = {
  id: number;
  connection_id: number;
  door: "api" | "mcp";
  action: string;
  ticket_key: string | null;
  idempotency_key: string | null;
  outcome: "done" | "refused" | "failed";
  code: string | null;
  created_at: string;
};

/**
 * Records one thing a connection asked for, then keeps only that connection's latest `keep`
 * rows. Also prunes rows older than 30 days, which an index on created_at makes quick.
 */
export function insertActivity(db: Db, row: Omit<ActivityRow, "id">, keep: number): void {
  const monthAgo = new Date(Date.parse(row.created_at) - 30 * 24 * 3600 * 1000).toISOString();
  db.prepare("DELETE FROM agent_activity WHERE created_at < ?").run(monthAgo);
  db.prepare(
    `INSERT INTO agent_activity
       (connection_id, door, action, ticket_key, idempotency_key, outcome, code, created_at)
     VALUES (@connection_id, @door, @action, @ticket_key, @idempotency_key, @outcome, @code, @created_at)`,
  ).run(row);
  // The row just past the latest `keep`, and every older one, go.
  db.prepare(
    `DELETE FROM agent_activity
     WHERE connection_id = ?
       AND id <= (SELECT id FROM agent_activity WHERE connection_id = ?
                  ORDER BY id DESC LIMIT 1 OFFSET ?)`,
  ).run(row.connection_id, row.connection_id, keep);
}

/** Deletes the activity of every demo connection that has ended, revoked or expired. */
export function forgetEndedDemoActivity(db: Db, now: string): void {
  db.prepare(
    `DELETE FROM agent_activity
     WHERE connection_id IN (SELECT id FROM agent_connections
                             WHERE demo = 1 AND (revoked_at IS NOT NULL OR expires_at <= ?))`,
  ).run(now);
}

/** A connection's latest activity, newest first. */
export function listActivity(db: Db, connectionId: number, limit: number): ActivityRow[] {
  return db
    .prepare("SELECT * FROM agent_activity WHERE connection_id = ? ORDER BY id DESC LIMIT ?")
    .all(connectionId, limit) as ActivityRow[];
}

export function markRevoked(db: Db, id: number, now: string): void {
  db.prepare("UPDATE agent_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
    now,
    id,
  );
}

export function markUsed(db: Db, id: number, now: string): void {
  db.prepare("UPDATE agent_connections SET last_used_at = ? WHERE id = ?").run(now, id);
}
