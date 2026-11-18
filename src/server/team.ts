import { entrancePeople } from "./actor.js";
import { githubIdOf, roleOf } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

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
    const users = db.prepare('SELECT id, name FROM "user" ORDER BY name').all() as TeamMember[];
    const signedIn = users.filter((user) => roleOf(config, githubIdOf(db, user.id)) !== "customer");
    return [...made, ...signedIn];
  };
}
