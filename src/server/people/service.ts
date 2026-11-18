import { z } from "zod";
import { DEMO_ACTORS, type Actor, type Role } from "../actor.js";
import { roleOf, settingsRoleOf } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError } from "../errors.js";
import { can } from "../permissions.js";
import { buildKey } from "../tickets/keys.js";
import { parse } from "../validation.js";
import * as repository from "./repository.js";

// The People page: an admin chooses who is on the team. The server settings come first and
// cannot be changed here, nobody changes their own role, and someone who still owns open
// tickets keeps the team role until those tickets have another owner.

export const ROLES = ["customer", "team", "admin"] as const satisfies readonly Role[];

/** Each role's name on the page. */
export const ROLE_LABELS: Record<Role, string> = {
  customer: "Customer",
  team: "Team member",
  admin: "Admin",
};

/** One short line for each role, shown beside its choice. */
export const ROLE_LINES: Record<Role, string> = {
  customer: "Customer: files tickets and sees only their own.",
  team: "Team member: works on every ticket and writes internal notes.",
  admin: "Admin: also restores and deletes tickets and chooses who is on the team.",
};

/** Each role as it reads inside a sentence. */
const ROLE_IN_A_SENTENCE: Record<Role, string> = {
  customer: "a customer",
  team: "a team member",
  admin: "an admin",
};

/** One row of the People page. */
export type PersonView = {
  id: string;
  name: string;
  email: string | null;
  firstSignedIn: string | null;
  role: Role;
  /** Why the role cannot be changed here, or null when an admin may change it. */
  locked: string | null;
};

/** One line of the history of role changes. */
export type RoleChangeView = {
  at: string;
  sentence: string;
};

/** Everything the People page shows. */
export type PeoplePage = {
  people: PersonView[];
  changes: RoleChangeView[];
  /** False for the read-only demo admin: every choice is shown and none can be made. */
  canChange: boolean;
  /** After a save, the one line that says what changed, or null. */
  changedLine: string | null;
};

const changeSchema = z.object({
  person: z.string().min(1, "Choose a person.").max(200),
  role: z.enum(ROLES, "Choose customer, team member or admin."),
});

/** Joins names as people write them: "A", "A and B", "A, B and C". */
function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function createPeopleService(db: Db, config: Config) {
  /** The page is for admins only, and never for an assistant's connection. */
  function mayLook(actor: Actor): void {
    if (!can(actor, "list_people")) {
      throw new HttpError(403, "forbidden", "Only an admin chooses who is on the team.");
    }
  }

  /** Why a person's role cannot be changed by this admin, or null when it can. */
  function lockOf(actor: Actor, person: repository.PersonRow): string | null {
    if (person.id === actor.id) return "You";
    const fromSettings = settingsRoleOf(config, person.github_id ?? undefined);
    if (fromSettings !== undefined)
      return `${ROLE_LABELS[fromSettings]}, set in the server settings`;
    return null;
  }

  function roleOfRow(person: repository.PersonRow): Role {
    return roleOf(config, person.github_id ?? undefined, person.chosen_role);
  }

  /** The demo's three made-up people, shown as they are, with nothing to change. */
  function demoPeople(actor: Actor): PersonView[] {
    return DEMO_ACTORS.map((person) => ({
      id: person.id,
      name: person.name,
      email: null,
      firstSignedIn: null,
      role: person.role,
      locked: person.id === actor.id ? "You" : null,
    }));
  }

  return {
    /** The People page for this admin. With the id of someone just changed, says what changed. */
    page(actor: Actor, changedId?: string): PeoplePage {
      mayLook(actor);
      if (config.demo) {
        return { people: demoPeople(actor), changes: [], canChange: false, changedLine: null };
      }
      const people = repository.listPeople(db).map((person) => ({
        id: person.id,
        name: person.name,
        email: person.email,
        firstSignedIn: person.first_signed_in,
        role: roleOfRow(person),
        locked: lockOf(actor, person),
      }));
      const changed = people.find((person) => person.id === changedId);
      const changes = repository.listChanges(db).map((change) => ({
        at: change.created_at,
        sentence:
          `${change.changed_by_name} made ${change.person_name} ` +
          `${ROLE_IN_A_SENTENCE[change.to_role]}. Before: ${ROLE_IN_A_SENTENCE[change.from_role]}.`,
      }));
      return {
        people,
        changes,
        canChange: can(actor, "change_role"),
        changedLine:
          changed === undefined
            ? null
            : `${changed.name} is now ${ROLE_IN_A_SENTENCE[changed.role]}.`,
      };
    },

    /**
     * Gives a person a new role and records the change, as one step. Returns the person's id.
     * A choice of the role they already have changes nothing and records nothing.
     */
    changeRole(actor: Actor, input: unknown): string {
      mayLook(actor);
      if (!can(actor, "change_role")) {
        throw new HttpError(403, "forbidden", "The demo admin changes nothing.");
      }
      const { person: personId, role } = parse(changeSchema, input);
      const person = repository.findPerson(db, personId);
      if (person === undefined) {
        throw new HttpError(404, "not_found", "Nobody with that id has signed in here.");
      }
      if (person.id === actor.id) {
        throw new HttpError(
          403,
          "forbidden",
          "You cannot change your own role. Ask another admin.",
        );
      }
      const fromSettings = settingsRoleOf(config, person.github_id ?? undefined);
      if (fromSettings !== undefined) {
        const setting = fromSettings === "admin" ? "ADMIN_GITHUB_IDS" : "TEAM_GITHUB_IDS";
        throw new HttpError(
          403,
          "forbidden",
          `${person.name} is ${ROLE_IN_A_SENTENCE[fromSettings]} by the server settings. ` +
            `Change ${setting} to change that.`,
        );
      }
      const before = roleOfRow(person);
      if (before === role) return person.id;
      if (role === "customer") {
        const owned = repository.openTicketsOwnedBy(db, person.id);
        if (owned.length > 0) {
          const keys = owned.map((id) => buildKey(config.ticketPrefix, id));
          const them = owned.length === 1 ? "it" : "them";
          throw new HttpError(
            409,
            "owns_tickets",
            `${person.name} still owns ${listInWords(keys)}. Hand ${them} to someone else first.`,
          );
        }
      }
      const now = new Date().toISOString();
      db.transaction(() => {
        repository.saveRole(db, person.id, role, now);
        repository.recordChange(db, {
          personId: person.id,
          personName: person.name,
          changedBy: actor.id,
          changedByName: actor.name,
          from: before,
          to: role,
          now,
        });
      })();
      return person.id;
    },
  };
}

export type PeopleService = ReturnType<typeof createPeopleService>;
