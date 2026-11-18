import { entrancePeople, type Role } from "../actor.js";
import { roleOf } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { findPerson } from "./repository.js";

/**
 * One person's role at this moment, by their id: a made-up person's own on the demo or the
 * development entrance, otherwise the role sign-in would give them now (the server settings,
 * then the People page, otherwise customer). Undefined for an id that belongs to nobody, such
 * as a person who was deleted. Anything that must not outlive a role asks this, not a copy.
 */
export function roleNowOf(config: Config, db: Db, personId: string): Role | undefined {
  const madeUp = entrancePeople(config).find((person) => person.id === personId);
  if (madeUp !== undefined) return madeUp.role;
  const person = findPerson(db, personId);
  if (person === undefined) return undefined;
  return roleOf(config, person.github_id ?? undefined, person.chosen_role);
}
