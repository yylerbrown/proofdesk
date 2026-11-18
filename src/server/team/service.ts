import { DEMO_ACTORS, DEV_ACTORS, entrancePeople, type Role } from "../actor.js";
import { roleOf } from "../auth.js";
import { DEMO_SEED_PEOPLE } from "../demo.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { listSignedInPeople } from "./repository.js";

/** A person a ticket can be handed to. */
export type TeamMember = { id: string; name: string };

/**
 * Who can own a ticket: the made-up team members and admins of the entrance, and the people who
 * have signed in with a GitHub account named as team or admin in the configuration. A read-only
 * demo admin is not among them. Read fresh each time, so a change of configuration counts.
 */
export function teamMembers(config: Config, db: Db): () => TeamMember[] {
  return () => {
    const made = entrancePeople(config)
      .filter((person) => person.role !== "customer" && person.readOnly !== true)
      .map(({ id, name }) => ({ id, name }));
    // One query for everyone who has signed in, with their GitHub user numbers.
    const signedIn = listSignedInPeople(db)
      .filter((person) => roleOf(config, person.github_id ?? undefined) !== "customer")
      .map(({ id, name }) => ({ id, name }));
    return [...made, ...signedIn];
  };
}

/**
 * Each person's role now, by their id: a made-up person's own, or for a GitHub account the role
 * the configuration gives its user number. It is shown beside a name wherever the name is read
 * live, so a display name such as "Proofdesk Support" cannot pass a customer off as the team.
 */
export function peopleRoles(config: Config, db: Db): (ids: string[]) => Map<string, Role> {
  return (ids) => {
    const wanted = new Set(ids);
    const roles = new Map<string, Role>();
    for (const person of [...DEV_ACTORS, ...DEMO_ACTORS, ...DEMO_SEED_PEOPLE]) {
      if (wanted.has(person.id)) roles.set(person.id, person.role);
    }
    for (const person of listSignedInPeople(db)) {
      if (wanted.has(person.id))
        roles.set(person.id, roleOf(config, person.github_id ?? undefined));
    }
    return roles;
  };
}
