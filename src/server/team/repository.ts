import type { Role } from "../actor.js";
import type { Db } from "../db.js";

// The SQL for the team list: the people who have signed in, read from the sign-in library's
// tables. Every statement here is a fixed string.

/**
 * A person who has signed in, with their GitHub user number when they signed in with GitHub,
 * and the role an admin chose for them on the People page, if any.
 */
export type SignedInPerson = {
  id: string;
  name: string;
  github_id: string | null;
  chosen_role: Role | null;
};

/**
 * Everyone who has signed in, by name, each with their GitHub user number and chosen role, in
 * one query.
 */
export function listSignedInPeople(db: Db): SignedInPerson[] {
  return db
    .prepare(
      `SELECT u.id, u.name, a."accountId" AS github_id, r.role AS chosen_role
       FROM "user" u
       LEFT JOIN "account" a ON a."userId" = u.id AND a."providerId" = 'github'
       LEFT JOIN people_roles r ON r.person_id = u.id
       ORDER BY u.name`,
    )
    .all() as SignedInPerson[];
}
