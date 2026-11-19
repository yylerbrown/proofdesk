import { DEMO_ACTORS, DEV_ACTORS, entrancePeople, type Role } from "../actor.js";
import { roleOf } from "../auth.js";
import { DEMO_SEED_PEOPLE } from "../demo.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { listPossibleTeam, listSignedInPeopleAmong } from "./repository.js";

/** A person a ticket can be handed to. */
export type TeamMember = { id: string; name: string };

/**
 * Who can own a ticket: the made-up team members and admins of the entrance, and the people who
 * have signed in whose role is team or admin, from the server settings or the People page. A
 * read-only demo admin is not among them. Read fresh each time, so a change counts at once.
 */
export function teamMembers(config: Config, db: Db): () => TeamMember[] {
  return () => {
    const made = entrancePeople(config)
      .filter((person) => person.role !== "customer" && person.readOnly !== true)
      .map(({ id, name }) => ({ id, name }));
    // One query for the people who may be on the team, never every customer who signed in.
    const settingsIds = [...config.adminGithubIds, ...config.teamGithubIds];
    const signedIn = listPossibleTeam(db, settingsIds)
      .filter(
        (person) =>
          roleOf(config, person.github_id ?? undefined, person.chosen_role) !== "customer",
      )
      .map(({ id, name }) => ({ id, name }));
    return [...made, ...signedIn];
  };
}

/**
 * Each person's role now, by their id: a made-up person's own, or for a signed-in person the
 * role from the server settings or the People page. It is shown beside a name wherever the name is read
 * live, so a display name such as "Proofdesk Support" cannot pass a customer off as the team.
 */
export function peopleRoles(config: Config, db: Db): (ids: string[]) => Map<string, Role> {
  return (ids) => {
    const wanted = new Set(ids);
    const roles = new Map<string, Role>();
    for (const person of [...DEV_ACTORS, ...DEMO_ACTORS, ...DEMO_SEED_PEOPLE]) {
      if (wanted.has(person.id)) roles.set(person.id, person.role);
    }
    // Only the people asked about, however many others have signed in.
    for (const person of listSignedInPeopleAmong(db, [...wanted])) {
      roles.set(person.id, roleOf(config, person.github_id ?? undefined, person.chosen_role));
    }
    return roles;
  };
}
