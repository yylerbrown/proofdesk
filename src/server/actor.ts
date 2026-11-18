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
 * The one place that decides who is acting. For now everyone is anonymous. A later step
 * will replace only this function, for example to read a sign-in or an API token.
 */
export const actorMiddleware: RequestHandler = (req, _res, next) => {
  req.actor = { id: "anonymous", kind: "person" };
  next();
};
