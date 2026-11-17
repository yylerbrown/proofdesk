import { fromNodeHeaders } from "better-auth/node";
import { Router } from "express";
import { DEV_COOKIE, entrancePeople } from "../actor.js";
import type { Auth } from "../auth.js";
import type { Config } from "../config.js";
import { HttpError } from "../errors.js";

// The sign-in page and its two ways in: GitHub, when its settings are present, and the
// development entrance, when DEV_SIGN_IN is on. The configuration refuses the development
// entrance in production.
/**
 * Where to go after signing in. Only an address on this site is accepted, such as
 * "/tickets/SUP-1". Anything else, for example "https://elsewhere" or "//elsewhere", falls
 * back to the ticket list, so the sign-in page cannot be used to send people to another site.
 */
export function safeNext(value: unknown): string {
  // One slash, then visible ASCII characters only, and not a second slash or a backslash
  // straight after the first. Browsers drop tabs and line breaks from an address, so
  // "/<tab>/elsewhere" would otherwise be read as "//elsewhere", which is another site.
  const isLocalPath = typeof value === "string" && /^\/(?![/\\])[\x21-\x7e]*$/.test(value);
  return isLocalPath ? value : "/tickets";
}

export function signInRouter(config: Config, auth: Auth | null): Router {
  const router = Router();

  router.get("/sign-in", (req, res) => {
    const people = entrancePeople(config);
    const next = safeNext(req.query.next);
    // The sign-in library returns here with "?error=..." when a GitHub sign-in fails.
    const failed = req.query.error !== undefined;
    res.render("sign-in", {
      title: "Sign in",
      people,
      github: auth !== null,
      next,
      failed,
      demo: config.demo,
    });
  });

  // Starts a GitHub sign-in. The library answers with the GitHub address to go to and a
  // short-lived cookie it uses to recognise the browser when GitHub sends it back to
  // /api/auth/callback/github. The library handles that return itself.
  router.post("/sign-in/github", async (req, res) => {
    if (auth === null) {
      throw new HttpError(404, "not_found", "There is no page at this address.");
    }
    const started = await auth.api.signInSocial({
      body: {
        provider: "github",
        callbackURL: safeNext(req.body?.next),
        errorCallbackURL: "/sign-in",
      },
      returnHeaders: true,
    });
    if (started.response.url === undefined) {
      throw new Error("The sign-in library did not return an address to go to.");
    }
    res.setHeader("Set-Cookie", started.headers.getSetCookie());
    res.redirect(303, started.response.url);
  });

  // The development entrance and the demo entrance share this route. Each offers its own
  // people, and neither is open unless its setting is on.
  router.post("/sign-in/dev", (req, res) => {
    if (entrancePeople(config).length === 0) {
      throw new HttpError(404, "not_found", "There is no page at this address.");
    }
    const id: unknown = req.body?.id;
    const person = entrancePeople(config).find((actor) => actor.id === id);
    if (person === undefined) {
      throw new HttpError(400, "unknown_person", "Pick one of the people on the sign-in page.");
    }
    // httpOnly keeps the cookie away from scripts. sameSite stops another site from
    // sending it along with a form post.
    res.cookie(DEV_COOKIE, person.id, { httpOnly: true, sameSite: "lax" });
    res.redirect(303, safeNext(req.body?.next));
  });

  // Ends both kinds of sign-in. The library deletes the session row and clears its cookie.
  router.post("/sign-out", async (req, res) => {
    if (auth !== null) {
      const ended = await auth.api.signOut({
        headers: fromNodeHeaders(req.headers),
        returnHeaders: true,
      });
      res.setHeader("Set-Cookie", ended.headers.getSetCookie());
    }
    res.clearCookie(DEV_COOKIE);
    res.redirect(303, "/sign-in");
  });

  return router;
}
