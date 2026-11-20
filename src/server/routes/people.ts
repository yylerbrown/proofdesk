import { Router, type Request, type Response } from "express";
import { signedIn } from "../actor.js";
import { HttpError } from "../errors.js";
import { formatTime } from "../pages/format.js";
import { can } from "../permissions.js";
import { ROLE_LINES, ROLES, type PeopleService } from "../people/service.js";
import { ROLE_LABELS } from "../people/words.js";

// The People page, for admins: everyone who has signed in, and the role of each. And the
// account page, where each person sees who Proofdesk thinks they are.

// After a save, this cookie holds the id of the person whose role changed, so the next page
// says what changed. It lives a minute and is read once, like the saved message of other forms.
// The line itself is built by the server from the person's role now, never from the cookie.
const CHANGED_COOKIE = "people_changed";

// After the account page's switch is saved, this cookie says so on the next page, once. The
// line is built from the setting as it is now, never from the cookie.
const ACCOUNT_SAVED_COOKIE = "account_saved";

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

  // What a role change would do, before anyone makes it. It only reads, so it is a plain
  // address that can be opened again, and the demo admin may open it too.
  router.get("/people/check", (req, res) => {
    const actor = signedIn(req);
    try {
      const preview = people.previewRoleChange(actor, req.query);
      res.render("people-confirm", { title: preview.question, ...preview });
    } catch (err) {
      // An admin sees why on the People page itself. Anyone else gets the plain refusal page.
      if (!(err instanceof HttpError) || !can(actor, "list_people")) throw err;
      show(req, res, err.status, err.message);
    }
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

  router.get("/account", (req, res) => {
    const page = people.account.page(signedIn(req));
    if (req.cookies?.[ACCOUNT_SAVED_COOKIE] !== undefined) {
      res.clearCookie(ACCOUNT_SAVED_COOKIE, { path: "/account" });
      res.locals.saved = page.emailMe
        ? "Saved. Proofdesk will email you about your tickets."
        : "Saved. Proofdesk will not email you about your tickets.";
    }
    res.render("account", { title: "Your account", ...page });
  });

  router.post("/account", (req, res) => {
    people.account.setEmailMe(signedIn(req), req.body);
    res.cookie(ACCOUNT_SAVED_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60_000,
      path: "/account",
    });
    res.redirect(303, "/account");
  });

  return router;
}
