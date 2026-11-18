import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { HttpError } from "../errors.js";
import { AGENT_SCOPES, can, type AgentScope } from "../permissions.js";
import { parse } from "../validation.js";
import * as repository from "./repository.js";

// Connections for AI agents. A connection identifies whoever holds its key; it is not a
// guarantee of one particular agent. An admin issues it with chosen scopes and sees the key
// once. Losing the key means revoking the connection and issuing another.

/** How long a demo connection lasts, and how many may be live at once. */
export const DEMO_CONNECTION_HOURS = 24;
export const DEMO_CONNECTION_LIMIT = 200;

/** How many of a connection's latest requests its activity trail keeps. Older ones are dropped. */
export const ACTIVITY_KEPT = 1000;

// What the activity trail stores of what an agent sent: a ticket key only when it has a
// ticket key's form, and an idempotency key only when a write would accept it. Anything else
// is stored as nothing, so a request cannot make its row as large as it likes.
const TICKET_KEY_FORM = /^[A-Z]{2,6}-[1-9][0-9]{0,15}$/;
const IDEMPOTENCY_KEY_MAX = 100;

/** What a new connection may do unless the admin chooses otherwise: read, write notes, attach evidence, propose a test spec. */
export const DEFAULT_SCOPES: AgentScope[] = [
  "read_tickets",
  "write_notes",
  "attach_evidence",
  "propose_specs",
];

/** What a visitor's demo connection may do: the same as a new connection's default. */
export const DEMO_SCOPES: AgentScope[] = DEFAULT_SCOPES;

// A form sends one checkbox as a text and several as a list; both are read as a list.
const scopeList = z.preprocess(
  (value) => (value === undefined ? [] : [value].flat()),
  z.array(z.enum(AGENT_SCOPES)).min(1, "Choose at least one thing it may do."),
);

export const createConnectionSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give it a name you will recognise.")
    .max(60, "Must be at most 60 characters."),
  scopes: scopeList,
});

/** A connection as people and programs see it. The key and its hash are never part of it. */
export type Connection = {
  id: number;
  name: string;
  key_prefix: string;
  scopes: AgentScope[];
  issued_by: string;
  demo: boolean;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

const KEY_PATTERN = /^pd_([0-9a-f]{8})_[A-Za-z0-9_-]{32}$/;

function hashOf(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

function toConnection(row: repository.ConnectionRow): Connection {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: JSON.parse(row.scopes) as AgentScope[],
    issued_by: row.issued_by,
    demo: row.demo === 1,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
  };
}

export function createConnectionService(db: Db) {
  function requireAdmin(actor: Actor): void {
    if (!can(actor, "manage_connections")) {
      throw new HttpError(403, "forbidden", "Only an admin manages connections.");
    }
  }

  /** Makes a new key. Only its hash is stored; the prefix is kept so people can tell keys apart. */
  function issue(
    name: string,
    scopes: AgentScope[],
    issuedBy: string,
    options: { demo: boolean; expiresAt: string | null },
  ) {
    const prefix = randomBytes(4).toString("hex");
    const key = `pd_${prefix}_${randomBytes(24).toString("base64url")}`;
    const id = repository.insertConnection(db, {
      // A demo visitor's connection is told apart by its key's prefix.
      name: options.demo ? `${name} ${prefix}` : name,
      keyPrefix: prefix,
      keyHash: hashOf(key).toString("hex"),
      scopes,
      issuedBy,
      demo: options.demo,
      now: new Date().toISOString(),
      expiresAt: options.expiresAt,
    });
    return { connection: toConnection(repository.findById(db, id)!), key };
  }

  return {
    /** Issues a connection. The answer holds the key, which is never shown again. */
    create(input: unknown, actor: Actor) {
      requireAdmin(actor);
      const { name, scopes } = parse(createConnectionSchema, input);
      return issue(name, scopes, actor.id, { demo: false, expiresAt: null });
    },

    /**
     * A visitor's own short-lived connection to the public demo. No admin issues it: anyone
     * on the demo's welcome page may ask. It sees only the sample tickets and what it writes
     * itself, it expires within a day, and only so many may be live at once. At that cap the
     * live one issued first is ended to make room. Using a key does not keep it, so nobody
     * can choose whose key the next one ends: pushing out a visitor's key takes a new
     * connection for every live one issued before it.
     */
    issueDemo() {
      const now = new Date();
      const live = repository.countLiveDemo(db, now.toISOString());
      if (live >= DEMO_CONNECTION_LIMIT) {
        repository.revokeOldestDemo(db, now.toISOString(), live - DEMO_CONNECTION_LIMIT + 1);
      }
      // What ended connections did is forgotten, so however many visitors come and go, the
      // demo keeps the trails of at most its live connections.
      repository.forgetEndedDemoActivity(db, now.toISOString());
      const expiresAt = new Date(now.getTime() + DEMO_CONNECTION_HOURS * 3600 * 1000);
      const issued = issue("Demo visitor", DEMO_SCOPES, "demo-welcome-page", {
        demo: true,
        expiresAt: expiresAt.toISOString(),
      });
      return issued;
    },

    /**
     * Records what an agent asked for and how it ended. A person's requests are not recorded
     * here: their history is the ticket's own.
     */
    record(
      actor: Actor,
      entry: {
        door: "api" | "mcp";
        action: string;
        ticketKey: string;
        idempotencyKey: string | undefined;
        outcome: "done" | "refused" | "failed";
        code: string | null;
      },
    ): void {
      if (actor.kind !== "agent" || actor.connection === undefined) return;
      repository.insertActivity(
        db,
        {
          connection_id: actor.connection.id,
          door: entry.door,
          action: entry.action,
          ticket_key: TICKET_KEY_FORM.test(entry.ticketKey) ? entry.ticketKey : null,
          idempotency_key:
            entry.idempotencyKey !== undefined && entry.idempotencyKey.length <= IDEMPOTENCY_KEY_MAX
              ? entry.idempotencyKey
              : null,
          outcome: entry.outcome,
          code: entry.code,
          created_at: new Date().toISOString(),
        },
        ACTIVITY_KEPT,
      );
    },

    /** One connection and its latest activity, for the team. */
    activity(id: number, viewer: Actor) {
      if (!can(viewer, "read_activity")) {
        throw new HttpError(403, "forbidden", "Only the team sees agent activity.");
      }
      const row = repository.findById(db, id);
      if (row === undefined) throw new HttpError(404, "not_found", "There is no such connection.");
      return {
        connection: toConnection(row),
        activity: repository.listActivity(db, id, 200),
      };
    },

    /** The issued connections, for the team to see. Only an admin issues or revokes them. */
    list(actor: Actor): Connection[] {
      if (!can(actor, "read_activity")) {
        throw new HttpError(403, "forbidden", "Only the team sees agent connections.");
      }
      return repository.listIssued(db).map(toConnection);
    },

    /** Cuts the connection off at once. Its history stays. */
    revoke(id: number, actor: Actor): Connection {
      requireAdmin(actor);
      const row = repository.findById(db, id);
      if (row === undefined || row.demo === 1) {
        throw new HttpError(404, "not_found", "There is no such connection.");
      }
      repository.markRevoked(db, id, new Date().toISOString());
      return toConnection(repository.findById(db, id)!);
    },

    /**
     * The agent a key belongs to, or null if the key is malformed, unknown, revoked or expired.
     * Comparing hashes in constant time keeps the comparison from leaking how much matched.
     */
    authenticate(key: string): Actor | null {
      const match = KEY_PATTERN.exec(key);
      if (match === null) return null;
      const row = repository.findByPrefix(db, match[1]!);
      if (row === undefined) return null;
      const stored = Buffer.from(row.key_hash, "hex");
      const given = hashOf(key);
      if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;
      const now = new Date().toISOString();
      if (row.revoked_at !== null) return null;
      if (row.expires_at !== null && row.expires_at <= now) return null;
      repository.markUsed(db, row.id, now);
      const connection = toConnection(row);
      return {
        id: `connection-${row.id}`,
        kind: "agent",
        role: "team",
        name: row.name,
        scopes: connection.scopes,
        connection: { id: row.id, name: row.name, issuedBy: row.issued_by },
        ...(connection.demo ? { demo: true } : {}),
      };
    },
  };
}

export type ConnectionService = ReturnType<typeof createConnectionService>;
