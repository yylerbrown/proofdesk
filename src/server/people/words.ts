import type { Actor, Role } from "../actor.js";

// The words the pages use for roles. They live here, apart from the People page's rules, so the
// header can use them on every page.

/** Each role's name on the page. */
export const ROLE_LABELS: Record<Role, string> = {
  customer: "Customer",
  team: "Team member",
  admin: "Admin",
};

/** The role of a signed-in person as the header shows it, such as "Team member". */
export function roleWordOf(actor: Actor): string {
  if (actor.readOnly === true) return `${ROLE_LABELS[actor.role]}, read-only`;
  return ROLE_LABELS[actor.role];
}

/**
 * Why an assistant connection ended when the person who issued it stopped being an admin, as
 * the Connections page shows it. Without a name, such as for a person who was deleted, it says
 * who they were instead.
 */
export function endedWhenNotAdmin(issuerName: string | undefined): string {
  const who = issuerName ?? "the person who issued it";
  return `Ended when ${who} stopped being an admin.`;
}
