import type { RequestHandler } from "express";

/** Who is doing something. Services record this on every event they write. */
export type Actor = {
  id: string;
  kind: "person" | "agent";
};

// Tell TypeScript that every request carries an actor once the middleware below has run.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor: Actor;
    }
  }
}

/**
 * The one place that decides who is acting. For now everyone is anonymous. Sign-in will
 * change this function. It will also have to change the service functions that only read
 * (list, get, events), because today they take no actor and so cannot limit who sees what.
 */
export const actorMiddleware: RequestHandler = (req, _res, next) => {
  req.actor = { id: "anonymous", kind: "person" };
  next();
};
