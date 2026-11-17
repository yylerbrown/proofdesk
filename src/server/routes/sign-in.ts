import { Router } from "express";
import { DEV_ACTORS, DEV_COOKIE } from "../actor.js";
import type { Config } from "../config.js";
import { HttpError } from "../errors.js";

// The sign-in page. Today its only way in is the development entrance: a list of made-up
// people to act as, with no password. It is offered only when DEV_SIGN_IN is on, and the
// configuration refuses that setting in production.
export function signInRouter(config: Config): Router {
  const router = Router();

  router.get("/sign-in", (_req, res) => {
    const people = config.devSignIn ? DEV_ACTORS : [];
    res.render("sign-in", { title: "Sign in", people });
  });

  router.post("/sign-in/dev", (req, res) => {
    if (!config.devSignIn) {
      throw new HttpError(404, "not_found", "There is no page at this address.");
    }
    const id: unknown = req.body?.id;
    const person = DEV_ACTORS.find((actor) => actor.id === id);
    if (person === undefined) {
      throw new HttpError(400, "unknown_person", "Pick one of the people on the sign-in page.");
    }
    // httpOnly keeps the cookie away from scripts. sameSite stops another site from
    // sending it along with a form post.
    res.cookie(DEV_COOKIE, person.id, { httpOnly: true, sameSite: "lax" });
    res.redirect(303, "/tickets");
  });

  router.post("/sign-out", (_req, res) => {
    res.clearCookie(DEV_COOKIE);
    res.redirect(303, "/sign-in");
  });

  return router;
}
