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

// The columns each query below reads: the person, their GitHub user number and chosen role.
const PERSON = `SELECT u.id, u.name, a."accountId" AS github_id, r.role AS chosen_role
       FROM "user" u
       LEFT JOIN "account" a ON a."userId" = u.id AND a."providerId" = 'github'
       LEFT JOIN people_roles r ON r.person_id = u.id`;

/**
 * The people with these ids who have signed in, each with their GitHub user number and chosen
 * role, in one query. It reads only those people, however many others have signed in.
 */
export function listSignedInPeopleAmong(db: Db, ids: string[]): SignedInPerson[] {
  return db
    .prepare(`${PERSON} WHERE u.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as SignedInPerson[];
}

/**
 * The people who have signed in and may be on the team, by name: those an admin chose as team
 * or admin on the People page, and those whose GitHub user number the server settings name. It
 * never reads the customers who have signed in, however many there are. The caller still works
 * out each one's role, because the server settings come first.
 */
export function listPossibleTeam(db: Db, settingsGithubIds: string[]): SignedInPerson[] {
  return db
    .prepare(
      `${PERSON}
       WHERE u.id IN (SELECT person_id FROM people_roles WHERE role IN ('team', 'admin'))
          OR u.id IN (
            SELECT "userId" FROM "account"
            WHERE "providerId" = 'github' AND "accountId" IN (SELECT value FROM json_each(?))
          )
       ORDER BY u.name`,
    )
    .all(JSON.stringify(settingsGithubIds)) as SignedInPerson[];
}
