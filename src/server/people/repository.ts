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

// Each person with their GitHub user number and the role an admin chose, if any.
const PEOPLE = `SELECT u.id, u.name, u.email, u."createdAt" AS first_signed_in,
         a."accountId" AS github_id, r.role AS chosen_role
  FROM "user" u
  LEFT JOIN "account" a ON a."userId" = u.id AND a."providerId" = 'github'
  LEFT JOIN people_roles r ON r.person_id = u.id`;

/** Everyone who has signed in, in the order they first signed in. */
export function listPeople(db: Db): PersonRow[] {
  return db.prepare(`${PEOPLE} ORDER BY u."createdAt", u.id`).all() as PersonRow[];
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

/** The numbers of the tickets a person owns that are not resolved yet, lowest first. */
export function openTicketsOwnedBy(db: Db, personId: string): number[] {
  const rows = db
    .prepare("SELECT id FROM tickets WHERE owner_id = ? AND status != 'resolved' ORDER BY id")
    .all(personId) as { id: number }[];
  return rows.map((row) => row.id);
}
