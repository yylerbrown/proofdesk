import { z } from "zod";
import { entrancePeople, type Actor, type Role } from "../actor.js";
import { roleOf, settingsRoleOf } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError } from "../errors.js";
import { can } from "../permissions.js";
import { endHandoffsToEndedConnections } from "../tickets/ended-connections.js";
import { OTHER_DEMO_CUSTOMERS } from "../demo-people.js";
import { buildKey } from "../tickets/keys.js";
import { parse } from "../validation.js";
import * as connectionsRepository from "../connections/repository.js";
import { createAccountService } from "./account.js";
import * as repository from "./repository.js";
import { roleNowOf } from "./role-now.js";
import { endedWhenNotAdmin, ROLE_LABELS, wayWordOf } from "./words.js";

// The People page: an admin chooses who is on the team. The server settings come first and
// cannot be changed here, nobody changes their own role, and someone who still owns open
// tickets keeps the team role until those tickets have another owner.

export const ROLES = ["customer", "team", "admin"] as const satisfies readonly Role[];

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

/** What each role will let the person do, as the check of a role change says it. */
const ROLE_FROM_NEXT_PAGE: Record<Role, string> = {
  customer: "will see only their own tickets from their next page.",
  team: "will work on every ticket and write internal notes from their next page.",
  admin:
    "will work on every ticket, delete tickets and choose who is on the team from their next page.",
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
  /**
   * How they signed in, as one word ("GitHub" or "Microsoft"), on a site with both ways in.
   * Null elsewhere, where everyone signed in the same way.
   */
  signedInWith: string | null;
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
  /** Why nothing can be changed here, on the demo and the development entrance, or null. */
  note: string | null;
  /** What stands in for the email address of a made-up person, or null on the real site. */
  madeUpLine: string | null;
  /** After a save, the one line that says what changed, or null. */
  changedLine: string | null;
  /** What the page says before anyone has signed in. */
  emptyLine: string;
};

/** What the People page says about the made-up people of the demo and the development entrance. */
const DEMO_NOTE = "Demo Admin (read-only) changes nothing here.";
const DEV_NOTE =
  "These people are made up for development and keep their roles. People who sign in with GitHub appear here.";

/** What the People page says before anyone has signed in with GitHub. */
const EMPTY_LINE = "Nobody has signed in with GitHub yet.";

/** What the check of a role change says to the next visitor on the demo. */
const DEMO_CHECK_NOTE =
  "Demo Admin (read-only) changes nothing, so there is no button here. " +
  "On the real site this is where the change is made.";

/** What changeRole did: the person's id, and whether their role changed. */
export type RoleChange = { personId: string; changed: boolean };

/** What a role change would do, worked out by the same checks as the change itself. */
export type RoleChangePreview = {
  personId: string;
  role: Role;
  /** The page's title, such as "Make Sam Lee a customer?". */
  question: string;
  /** What would happen, one line each. */
  happens: string[];
  /** Why the change cannot go ahead as it is, or null when it can. */
  stop: string | null;
  /** The words of the button that makes the change, or null when there is no button. */
  button: string | null;
  /** Why nothing can be changed here, on the demo and the development entrance, or null. */
  note: string | null;
};

/** A person whose role may change, from the database or from the made-up people. */
type Target = { id: string; name: string; githubId: string | undefined; role: Role };

/** Everything a role change would do, before anything is written. */
type Plan = {
  person: Target;
  before: Role;
  role: Role;
  /** Why the change cannot go ahead, such as tickets the person still owns, or null. */
  owns: string | null;
  /** How many assistant connections the change would revoke. */
  revokes: number;
};

const changeSchema = z.object(
  {
    person: z.string("Choose a person.").min(1, "Choose a person.").max(200),
    role: z.enum(ROLES, "Choose customer, team member or admin."),
  },
  "Choose a person and a role.",
);

/** Joins names as people write them: "A", "A and B", "A, B and C". */
function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function createPeopleService(db: Db, config: Config) {
  // True on a site that offers Microsoft beside GitHub.
  const bothWays = config.signIn?.microsoft != null;

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

  /**
   * " Their 1 assistant connection was revoked.", when the person's last role change revoked
   * their connections, otherwise nothing. Both are written with the same time, which links
   * them. Read from the database, never from the browser.
   */
  function revokedWords(personId: string): string {
    const changedAt = repository.lastChangeTimeOf(db, personId);
    if (changedAt === undefined) return "";
    const revoked = connectionsRepository.countRevokedAt(db, personId, changedAt);
    if (revoked === 0) return "";
    const noun = revoked === 1 ? "assistant connection was" : "assistant connections were";
    return ` Their ${revoked} ${noun} revoked.`;
  }

  /** The made-up people of the demo or the development entrance, with the demo's other customers. */
  function madeUpActors(): Actor[] {
    if (config.demo) return [...entrancePeople(config), ...OTHER_DEMO_CUSTOMERS];
    return entrancePeople(config);
  }

  /** The made-up people of the demo or the development entrance, shown as they are. */
  function madeUpPeople(actor: Actor): PersonView[] {
    return madeUpActors().map((person) => ({
      id: person.id,
      name: person.name,
      email: null,
      firstSignedIn: null,
      role: person.role,
      locked: person.id === actor.id ? "You" : null,
      signedInWith: null,
    }));
  }

  /** The person a role change is for: a made-up one on the demo and the entrance, else a row. */
  function targetOf(personId: string): Target {
    if (config.demo || config.devSignIn) {
      const madeUp = madeUpActors().find((person) => person.id === personId);
      if (madeUp === undefined) {
        throw new HttpError(404, "not_found", "Nobody with that id is on this page.");
      }
      return { id: madeUp.id, name: madeUp.name, githubId: undefined, role: madeUp.role };
    }
    const person = repository.findPerson(db, personId);
    if (person === undefined) {
      throw new HttpError(404, "not_found", "Nobody with that id has signed in here.");
    }
    return {
      id: person.id,
      name: person.name,
      githubId: person.github_id ?? undefined,
      role: roleOfRow(person),
    };
  }

  /**
   * Every check of a role change, in order, and what the change would do. It throws for a
   * change that may never be made here, and reads only: the caller decides whether to write.
   */
  function planOf(actor: Actor, input: unknown): Plan {
    const { person: personId, role } = parse(changeSchema, input);
    const person = targetOf(personId);
    if (person.id === actor.id) {
      throw new HttpError(403, "forbidden", "You cannot change your own role. Ask another admin.");
    }
    const fromSettings = settingsRoleOf(config, person.githubId);
    if (fromSettings !== undefined) {
      const setting = fromSettings === "admin" ? "ADMIN_GITHUB_IDS" : "TEAM_GITHUB_IDS";
      throw new HttpError(
        403,
        "forbidden",
        `${person.name} is ${ROLE_IN_A_SENTENCE[fromSettings]} by the server settings. ` +
          `Change ${setting} to change that.`,
      );
    }
    const before = person.role;
    const changes = before !== role;
    const owns = changes && role === "customer" ? ownedWords(person) : null;
    const revokes =
      changes && before === "admin" ? connectionsRepository.countLiveIssuedBy(db, person.id) : 0;
    return { person, before, role, owns, revokes };
  }

  /** Which open tickets the person still owns, as the refusal says it, or null for none. */
  function ownedWords(person: Target): string | null {
    const owned = repository.openTicketsOwnedBy(db, person.id);
    if (owned.length === 0) return null;
    const keys = owned.map((ticket) => buildKey(config.ticketPrefix, ticket.id));
    const them = owned.length === 1 ? "it" : "them";
    let message = `${person.name} still owns ${listInWords(keys)}. Hand ${them} to someone else first.`;
    // An archived ticket offers only Restore, so say that it comes first.
    const archived = owned.filter((ticket) => ticket.archived);
    if (archived.length > 0) {
      const archivedKeys = archived.map((ticket) => buildKey(config.ticketPrefix, ticket.id));
      const isAre = archived.length === 1 ? "is" : "are";
      message += ` ${listInWords(archivedKeys)} ${isAre} archived: restore before handing on.`;
    }
    return message;
  }

  return {
    /** Each person's own account page, which shares the People page's routes. */
    account: createAccountService(db, config),

    /** The People page for this admin. With the id of someone just changed, says what changed. */
    page(actor: Actor, changedId?: string): PeoplePage {
      mayLook(actor);
      if (config.demo || config.devSignIn) {
        return {
          people: madeUpPeople(actor),
          changes: [],
          note: config.demo ? DEMO_NOTE : DEV_NOTE,
          madeUpLine: config.demo ? "Made up for the demo" : "Made up for development",
          changedLine: null,
          emptyLine: EMPTY_LINE,
        };
      }
      const people = repository.listPeople(db).map((person) => ({
        id: person.id,
        name: person.name,
        email: person.email,
        firstSignedIn: person.first_signed_in,
        role: roleOfRow(person),
        locked: lockOf(actor, person),
        signedInWith: bothWays ? wayWordOf(person.signed_in_with) : null,
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
        note: null,
        madeUpLine: null,
        emptyLine: bothWays ? "Nobody has signed in yet." : EMPTY_LINE,
        changedLine:
          changed === undefined
            ? null
            : `${changed.name} is now ${ROLE_IN_A_SENTENCE[changed.role]}.` +
              revokedWords(changed.id),
      };
    },

    /**
     * What a role change would do, worked out by every check the change itself runs, and
     * written nowhere. It needs only the People page, so the demo admin can try it.
     */
    previewRoleChange(actor: Actor, input: unknown): RoleChangePreview {
      mayLook(actor);
      const plan = planOf(actor, input);
      const { person, role } = plan;
      const question = `Make ${person.name} ${ROLE_IN_A_SENTENCE[role]}?`;
      const madeUp = config.demo || config.devSignIn;
      const note = madeUp ? (config.demo ? DEMO_CHECK_NOTE : DEV_NOTE) : null;
      if (plan.before === role) {
        return {
          personId: person.id,
          role,
          question,
          happens: [],
          stop: `${person.name} is already ${ROLE_IN_A_SENTENCE[role]}. Nothing would change.`,
          button: null,
          note,
        };
      }
      const happens = [`${person.name} ${ROLE_FROM_NEXT_PAGE[role]}`];
      if (plan.revokes > 0) {
        const noun = plan.revokes === 1 ? "assistant connection" : "assistant connections";
        happens.push(`Their ${plan.revokes} ${noun} will be revoked.`);
      }
      const mayMake = plan.owns === null && !madeUp && can(actor, "change_role");
      return {
        personId: person.id,
        role,
        question,
        happens,
        stop: plan.owns,
        button: mayMake ? `Make ${person.name} ${ROLE_IN_A_SENTENCE[role]}` : null,
        note,
      };
    },

    /**
     * Gives a person a new role and records the change, as one step. A choice of the role
     * they already have changes nothing and records nothing, and says so. The checks read the
     * database inside the same step, so nothing can change between the check and the write.
     */
    changeRole(actor: Actor, input: unknown): RoleChange {
      mayLook(actor);
      if (!can(actor, "change_role") || config.demo) {
        throw new HttpError(403, "forbidden", "The demo admin changes nothing.");
      }
      if (config.devSignIn) {
        throw new HttpError(
          403,
          "forbidden",
          "The made-up people of the development entrance keep their roles.",
        );
      }
      const change = db.transaction((): RoleChange => {
        const plan = planOf(actor, input);
        const { person, before, role } = plan;
        if (before === role) return { personId: person.id, changed: false };
        if (plan.owns !== null) throw new HttpError(409, "owns_tickets", plan.owns);
        const now = new Date().toISOString();
        repository.saveRole(db, person.id, role, now);
        // Only an admin issues assistant connections, so someone who stops being an admin
        // loses the ones they issued, in the same step. The key would stop working anyway.
        if (before === "admin") {
          connectionsRepository.revokeIssuedBy(db, person.id, now, endedWhenNotAdmin(person.name));
          endHandoffsToEndedConnections(db, actor.id);
        }
        repository.recordChange(db, {
          personId: person.id,
          personName: person.name,
          changedBy: actor.id,
          changedByName: actor.name,
          from: before,
          to: role,
          now,
        });
        return { personId: person.id, changed: true };
      });
      return change.immediate();
    },
  };
}

export type PeopleService = ReturnType<typeof createPeopleService>;

/** Who the history of role changes names for a change the server settings made. */
const SETTINGS_CHANGER = { id: "server-settings", name: "The server settings" };

/**
 * Forgets the roles chosen on the People page for people the server settings now name, in one
 * step, and records one history line for each whose stored role differs. The settings already
 * win while they name someone, and the People page cannot change such a person. Without this,
 * a role chosen long ago would come back the day the settings stop naming them. The settings
 * change only with a restart, so running this as the server starts is enough. Returns how many
 * stored roles were forgotten.
 */
export function forgetRolesNamedInSettings(db: Db, config: Config): number {
  const forget = db.transaction((): number => {
    const now = new Date().toISOString();
    let forgotten = 0;
    for (const person of repository.listPeople(db)) {
      if (person.chosen_role === null) continue;
      const fromSettings = settingsRoleOf(config, person.github_id ?? undefined);
      if (fromSettings === undefined) continue;
      repository.forgetRole(db, person.id);
      forgotten += 1;
      if (person.chosen_role === fromSettings) continue;
      repository.recordChange(db, {
        personId: person.id,
        personName: person.name,
        changedBy: SETTINGS_CHANGER.id,
        changedByName: SETTINGS_CHANGER.name,
        from: person.chosen_role,
        to: fromSettings,
        now,
      });
    }
    return forgotten;
  });
  return forget.immediate();
}

/**
 * Ends every live assistant connection whose issuer is no longer an admin, in one step, with the
 * reason the Connections page shows. Such a key is already refused when it signs in. This makes
 * the Connections page and the list of connections a ticket can be handed to say the same. The
 * People page ends them itself when it lowers a role, so this catches the server settings, which
 * change only with a restart. Run it after forgetRolesNamedInSettings, once roles are settled.
 * Demo connections are issued by the demo, not a person, and are left alone. Returns how many
 * connections were ended.
 */
export function endConnectionsOfFormerAdmins(db: Db, config: Config): number {
  const end = db.transaction((): number => {
    const now = new Date().toISOString();
    let ended = 0;
    for (const issuerId of connectionsRepository.issuersOfLiveConnections(db)) {
      if (roleNowOf(config, db, issuerId) === "admin") continue;
      const issuer = repository.findPerson(db, issuerId);
      const reason = endedWhenNotAdmin(issuer?.name);
      ended += connectionsRepository.revokeIssuedBy(db, issuerId, now, reason);
    }
    endHandoffsToEndedConnections(db, SETTINGS_CHANGER.id);
    return ended;
  });
  return end.immediate();
}
