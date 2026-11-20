import { z } from "zod";
import type { Actor, Role } from "../actor.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { HttpError } from "../errors.js";
import { parse } from "../validation.js";
import * as repository from "./repository.js";
import { roleWordOf, wayWordOf } from "./words.js";

// The account page: who Proofdesk thinks the signed-in person is, and their one setting, the
// switch for email notices. It only ever shows the person who is looking.

/** One line for each role, on what it allows. */
const ROLE_ALLOWS: Record<Role, string> = {
  customer: "You file tickets, follow your own and say whether a fix worked.",
  team: "You see every ticket and work on it with the team.",
  admin:
    "You do everything a team member does, and also delete tickets and choose who is on the team.",
};

/** What the demo's read-only admin may do. */
const READ_ONLY_ALLOWS = "You see everything an admin sees, and change nothing.";

/** Everything the account page shows. */
export type AccountPage = {
  name: string;
  /** The email address Proofdesk holds, or null for a made-up person. */
  email: string | null;
  /** What stands in for the address of a made-up person, or null for a real one. */
  madeUpLine: string | null;
  /** Where the email address comes from, under it, or null for a made-up person. */
  emailFrom: string | null;
  /**
   * How the person signed in, as one word, on a site with both ways in. Null elsewhere, where
   * everyone signed in the same way.
   */
  signedInWith: string | null;
  roleWord: string;
  roleAllows: string;
  /** True for a customer, who is told how to join the support team. */
  showAskAnAdmin: boolean;
  /** True for an admin, who is given the way to the People page. */
  showPeopleLink: boolean;
  emailMe: boolean;
  /** False on the demo, which never sends email, and for the read-only admin. */
  canChangeEmailMe: boolean;
  /** The one line under the switch that says what this site does with email, or null. */
  mailLine: string | null;
};

const emailMeSchema = z.object({
  // A ticked checkbox sends "on". An unticked one sends nothing at all.
  email_me: z.literal("on", "Tick the box or leave it empty.").optional(),
});

/** People only: an assistant's connection has no account page. */
function mustBePerson(actor: Actor): void {
  if (actor.kind !== "person") {
    throw new HttpError(403, "forbidden", "An assistant's connection has no account page.");
  }
}

export function createAccountService(db: Db, config: Config) {
  /** Whether this person may change their email setting here. */
  function mayChange(actor: Actor): boolean {
    return !config.demo && actor.readOnly !== true;
  }

  /** The line under the switch: true for this site, or null when email is sent. */
  function mailLine(): string | null {
    if (config.demo) return "The demo sends no email";
    if (config.mail === null)
      return "This site has no mail server set up, so no email is sent yet.";
    return null;
  }

  /** Where an address comes from, by how the person signed in. */
  const EMAIL_FROM: Record<string, string> = {
    GitHub: "From your GitHub account; change it on GitHub.",
    Microsoft: "From your Microsoft account; your organization changes it there.",
  };

  return {
    /** The account page of the person who is looking. */
    page(actor: Actor): AccountPage {
      mustBePerson(actor);
      // The address Proofdesk holds for a person who signed in with GitHub or Microsoft.
      const person = repository.findPerson(db, actor.id);
      const email = person === undefined || person.email === "" ? null : person.email;
      const way = wayWordOf(person?.signed_in_with);
      let madeUpLine: string | null = null;
      if (email === null) {
        madeUpLine = config.demo
          ? "None on the demo"
          : "Made up for development, so Proofdesk holds no address.";
      }
      return {
        name: actor.name,
        email,
        madeUpLine,
        emailFrom: email === null || way === null ? null : (EMAIL_FROM[way] ?? null),
        signedInWith: config.signIn?.microsoft != null ? way : null,
        roleWord: roleWordOf(actor),
        roleAllows: actor.readOnly === true ? READ_ONLY_ALLOWS : ROLE_ALLOWS[actor.role],
        showAskAnAdmin: actor.role === "customer",
        showPeopleLink: actor.role === "admin",
        emailMe: repository.emailMeOf(db, actor.id),
        canChangeEmailMe: mayChange(actor),
        mailLine: mailLine(),
      };
    },

    /** Saves the "Email me about my tickets" switch for the person who is looking. */
    setEmailMe(actor: Actor, input: unknown): void {
      mustBePerson(actor);
      if (!mayChange(actor)) {
        throw new HttpError(
          403,
          "forbidden",
          "This demo never sends email, so there is nothing to switch.",
        );
      }
      const { email_me } = parse(emailMeSchema, input ?? {});
      repository.saveEmailMe(db, actor.id, email_me === "on", new Date().toISOString());
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
