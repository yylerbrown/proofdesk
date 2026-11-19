import type { Role } from "../actor.js";
import type { Db } from "../db.js";

// The SQL for the People page: who has signed in, the roles admins chose for them, and the
// history of those choices. Every statement here is a fixed string.

/** A person who has signed in, as the People page lists them. */
export type PersonRow = {
  id: string;
  name: string;
  email: string;
  first_signed_in: string;
  github_id: string | null;
  /** How they signed in: "github" or "microsoft". Each person has one account. */
  signed_in_with: string | null;
  chosen_role: Role | null;
};

/** One change of role, as it was recorded. */
export type RoleChangeRow = {
  id: number;
  person_name: string;
  changed_by_name: string;
  from_role: Role;
  to_role: Role;
  created_at: string;
};

// Each person with their GitHub user number, how they signed in and the role an admin chose,
// if any. Accounts are never linked, so each person has one account.
const PEOPLE = `SELECT u.id, u.name, u.email, u."createdAt" AS first_signed_in,
         a."accountId" AS github_id,
         (SELECT w."providerId" FROM "account" w WHERE w."userId" = u.id LIMIT 1) AS signed_in_with,
         r.role AS chosen_role
  FROM "user" u
  LEFT JOIN "account" a ON a."userId" = u.id AND a."providerId" = 'github'
  LEFT JOIN people_roles r ON r.person_id = u.id`;

/** Everyone who has signed in, in the order they first signed in. */
export function listPeople(db: Db): PersonRow[] {
  // Two people can sign in within the same millisecond. The row number of the sign-in table
  // grows with each new person, so it keeps them in the order they arrived.
  return db.prepare(`${PEOPLE} ORDER BY u."createdAt", u.rowid`).all() as PersonRow[];
}

/** One person who has signed in, or undefined when there is nobody with that id. */
export function findPerson(db: Db, id: string): PersonRow | undefined {
  return db.prepare(`${PEOPLE} WHERE u.id = ?`).get(id) as PersonRow | undefined;
}

/** The role an admin chose for a person on the People page, or null when none was chosen. */
export function chosenRoleOf(db: Db, personId: string): Role | null {
  const row = db.prepare("SELECT role FROM people_roles WHERE person_id = ?").get(personId) as
    { role: Role } | undefined;
  return row?.role ?? null;
}

/** Stores the role chosen for a person, replacing any earlier choice. */
export function saveRole(db: Db, personId: string, role: Role, now: string): void {
  db.prepare(
    `INSERT INTO people_roles (person_id, role, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (person_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
  ).run(personId, role, now);
}

/** Forgets the role chosen for a person, so they fall back to the server settings or customer. */
export function forgetRole(db: Db, personId: string): void {
  db.prepare("DELETE FROM people_roles WHERE person_id = ?").run(personId);
}

/** When this person's role last changed, or undefined when it never has. */
export function lastChangeTimeOf(db: Db, personId: string): string | undefined {
  const row = db
    .prepare("SELECT MAX(created_at) AS at FROM role_changes WHERE person_id = ?")
    .get(personId) as { at: string | null };
  return row.at ?? undefined;
}

/** Adds one line to the history of role changes. */
export function recordChange(
  db: Db,
  change: {
    personId: string;
    personName: string;
    changedBy: string;
    changedByName: string;
    from: Role;
    to: Role;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO role_changes
       (person_id, person_name, changed_by, changed_by_name, from_role, to_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    change.personId,
    change.personName,
    change.changedBy,
    change.changedByName,
    change.from,
    change.to,
    change.now,
  );
}

/** Every change of role, newest first. */
export function listChanges(db: Db): RoleChangeRow[] {
  return db
    .prepare(
      `SELECT id, person_name, changed_by_name, from_role, to_role, created_at
       FROM role_changes ORDER BY id DESC`,
    )
    .all() as RoleChangeRow[];
}

/**
 * The tickets a person owns that are not resolved yet, lowest first, and whether each is
 * archived. An archived ticket counts too: restored, it would still have this owner.
 */
export function openTicketsOwnedBy(db: Db, personId: string): { id: number; archived: boolean }[] {
  const rows = db
    .prepare(
      `SELECT id, archived_at IS NOT NULL AS archived FROM tickets
       WHERE owner_id = ? AND status != 'resolved' ORDER BY id`,
    )
    .all(personId) as { id: number; archived: number }[];
  return rows.map((row) => ({ id: row.id, archived: row.archived === 1 }));
}

/**
 * Whether a person wants email about their tickets: their choice on the account page, or yes
 * when they never made one.
 */
export function emailMeOf(db: Db, personId: string): boolean {
  const row = db
    .prepare("SELECT email_me FROM email_settings WHERE person_id = ?")
    .get(personId) as { email_me: number } | undefined;
  return row === undefined ? true : row.email_me === 1;
}

/** Stores a person's choice about email notices, replacing any earlier one. */
export function saveEmailMe(db: Db, personId: string, emailMe: boolean, now: string): void {
  db.prepare(
    `INSERT INTO email_settings (person_id, email_me, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (person_id) DO UPDATE SET email_me = excluded.email_me, updated_at = excluded.updated_at`,
  ).run(personId, emailMe ? 1 : 0, now);
}
