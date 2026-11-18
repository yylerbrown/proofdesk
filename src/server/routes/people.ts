import { Router, type Request, type Response } from "express";
import { signedIn } from "../actor.js";
import { HttpError } from "../errors.js";
import { formatTime } from "../pages/format.js";
import { can } from "../permissions.js";
import { ROLE_LABELS, ROLE_LINES, ROLES, type PeopleService } from "../people/service.js";

// The People page, for admins: everyone who has signed in, and the role of each.

export function peopleRouter(people: PeopleService): Router {
  const router = Router();

  function show(req: Request, res: Response, status = 200, refused: string | null = null) {
    const actor = signedIn(req);
    const changedId = typeof req.query.changed === "string" ? req.query.changed : undefined;
    const page = people.page(actor, refused === null ? changedId : undefined);
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
      const changed = people.changeRole(actor, req.body);
      res.redirect(303, `/people?changed=${encodeURIComponent(changed)}`);
    } catch (err) {
      // An admin sees why on the page itself. Anyone else gets the plain refusal page.
      if (!(err instanceof HttpError) || !can(actor, "list_people")) throw err;
      show(req, res, err.status, err.message);
    }
  });

  return router;
}
