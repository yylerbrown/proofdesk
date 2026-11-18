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

export function markRevoked(db: Db, id: number, now: string): void {
  db.prepare("UPDATE agent_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
    now,
    id,
  );
}

export function markUsed(db: Db, id: number, now: string): void {
  db.prepare("UPDATE agent_connections SET last_used_at = ? WHERE id = ?").run(now, id);
}
