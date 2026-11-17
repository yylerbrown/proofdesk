import { fromNodeHeaders } from "better-auth/node";
import type { RequestHandler } from "express";
import { githubIdOf, roleOf, type Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
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
  /** True for the demo admin, who may look at everything and change nothing. */
  readOnly?: boolean;
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

/**
 * The people of the public demo, offered when DEMO is on. The demo admin is read-only: the
 * demo's data is shared by every visitor, and an admin could archive or delete all of it.
 */
export const DEMO_ACTORS: Actor[] = [
  { id: "demo-customer", kind: "person", role: "customer", name: "Demo Customer" },
  { id: "demo-team", kind: "person", role: "team", name: "Demo Team Member" },
  { id: "demo-admin", kind: "person", role: "admin", name: "Demo Admin", readOnly: true },
];

/** The made-up people this server offers on its sign-in page: development, demo, or none. */
export function entrancePeople(config: Config): Actor[] {
  if (config.devSignIn) return DEV_ACTORS;
  if (config.demo) return DEMO_ACTORS;
  return [];
}

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
 * The one place that decides who is acting. It reads only cookies, never a field of the
 * request body or the address, so a caller cannot name themselves.
 *
 * There are two ways in. A GitHub sign-in leaves a session cookie that the sign-in library
 * checks against the database. The development entrance leaves a cookie naming a made-up
 * person, and counts only when DEV_SIGN_IN is on.
 *
 * The function is async because asking the library is: "await" waits for its answer.
 */
export function actorMiddleware(config: Config, auth: Auth | null, db: Db): RequestHandler {
  return async (req, res, next) => {
    req.actor = null;
    res.locals.viewer = null; // templates read this to show who is signed in
    if (auth !== null) {
      const found = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
        returnHeaders: true,
      });
      // The library extends a session that is in use and sends a fresh cookie for it.
      // Pass that cookie on, or the browser's copy would run out while the session lives.
      const cookies = found.headers.getSetCookie();
      if (cookies.length > 0) res.append("Set-Cookie", cookies);
      const session = found.response;
      if (session !== null) {
        req.actor = {
          id: session.user.id,
          kind: "person",
          role: roleOf(config, githubIdOf(db, session.user.id)),
          name: session.user.name,
        };
      }
    }
    if (req.actor === null) {
      const id: unknown = req.cookies[DEV_COOKIE];
      req.actor = entrancePeople(config).find((actor) => actor.id === id) ?? null;
    }
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
