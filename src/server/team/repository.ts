import type { Db } from "../db.js";

// The SQL for the team list: the people who have signed in, read from the sign-in library's
// tables. Every statement here is a fixed string.

/** A person who has signed in, with their GitHub user number when they signed in with GitHub. */
export type SignedInPerson = { id: string; name: string; github_id: string | null };

/** Everyone who has signed in, by name, each with their GitHub user number, in one query. */
export function listSignedInPeople(db: Db): SignedInPerson[] {
  return db
    .prepare(
      `SELECT u.id, u.name, a."accountId" AS github_id
       FROM "user" u
       LEFT JOIN "account" a ON a."userId" = u.id AND a."providerId" = 'github'
       ORDER BY u.name`,
    )
    .all() as SignedInPerson[];
}
