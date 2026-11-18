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
