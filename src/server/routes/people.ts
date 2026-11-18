import { Router, type Request, type Response } from "express";
import { signedIn } from "../actor.js";
import { HttpError } from "../errors.js";
import { formatTime } from "../pages/format.js";
import { can } from "../permissions.js";
import { ROLE_LABELS, ROLE_LINES, ROLES, type PeopleService } from "../people/service.js";

// The People page, for admins: everyone who has signed in, and the role of each.

// After a save, this cookie holds the id of the person whose role changed, so the next page
// says what changed. It lives a minute and is read once, like the saved message of other forms.
// The line itself is built by the server from the person's role now, never from the cookie.
const CHANGED_COOKIE = "people_changed";

export function peopleRouter(people: PeopleService): Router {
  const router = Router();

  /** The id of the person just changed, once: reading it clears it. */
  function takeChanged(req: Request, res: Response): string | undefined {
    const id: unknown = req.cookies?.[CHANGED_COOKIE];
    if (id === undefined) return undefined;
    res.clearCookie(CHANGED_COOKIE, { path: "/people" });
    return typeof id === "string" ? id : undefined;
  }

  function show(req: Request, res: Response, status = 200, refused: string | null = null) {
    const actor = signedIn(req);
    const page = people.page(actor, refused === null ? takeChanged(req, res) : undefined);
    if (page.changedLine !== null) res.locals.saved = page.changedLine;
    if (refused !== null) res.locals.refused = refused;
    res.status(status).render("people", {
      title: "People",
      ...page,
      roles: ROLES,
      roleLabels: ROLE_LABELS,
      roleLines: ROLE_LINES,
      formatTime,
    });
  }

  router.get("/people", (req, res) => {
    show(req, res);
  });

  router.post("/people", (req, res) => {
    const actor = signedIn(req);
    try {
      const result = people.changeRole(actor, req.body);
      if (result.changed) {
        res.cookie(CHANGED_COOKIE, result.personId, {
          httpOnly: true,
          sameSite: "lax",
          maxAge: 60_000,
          path: "/people",
        });
      }
      res.redirect(303, "/people");
    } catch (err) {
      // An admin sees why on the page itself. Anyone else gets the plain refusal page.
      if (!(err instanceof HttpError) || !can(actor, "list_people")) throw err;
      show(req, res, err.status, err.message);
    }
  });

  return router;
}
