import type { RequestHandler } from "express";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";

export type Role = "customer" | "team" | "admin";

/**
 * Who is doing something. The id is an opaque text handed out by whatever signs people in.
 * Nothing else in the app looks inside it. Tickets and events store it as it is.
 */
export type Actor = {
  id: string;
  kind: "person" | "agent";
  role: Role;
  name: string;
};

/**
 * The people of the development entrance. They exist only when DEV_SIGN_IN is on, which the
 * configuration refuses in production. Two customers, so that "a customer sees only their
 * own tickets" can be tried by hand and in tests.
 */
export const DEV_ACTORS: Actor[] = [
  { id: "dev-customer-1", kind: "person", role: "customer", name: "Customer One" },
  { id: "dev-customer-2", kind: "person", role: "customer", name: "Customer Two" },
  { id: "dev-team-1", kind: "person", role: "team", name: "Team Member" },
  { id: "dev-admin-1", kind: "person", role: "admin", name: "Admin" },
];

export const DEV_COOKIE = "dev_actor";

// Tell TypeScript that every request carries an actor (or null when nobody is signed in)
// once the middleware below has run.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor: Actor | null;
    }
  }
}

/**
 * The one place that decides who is acting. It reads only the sign-in cookie, never a field
 * of the request body or the address, so a caller cannot name themselves. Today the only
 * way in is the development entrance. Real sign-in will add a second way here.
 */
export function actorMiddleware(config: Config): RequestHandler {
  return (req, res, next) => {
    req.actor = null;
    if (config.devSignIn) {
      const id: unknown = req.cookies[DEV_COOKIE];
      req.actor = DEV_ACTORS.find((actor) => actor.id === id) ?? null;
    }
    // Templates read this to show who is signed in.
    res.locals.viewer = req.actor;
    next();
  };
}

/** Returns the actor of a request, or throws 401 when nobody is signed in. */
export function signedIn(req: { actor: Actor | null }): Actor {
  if (req.actor === null) {
    throw new HttpError(401, "not_signed_in", "Sign in to do that.");
  }
  return req.actor;
}
