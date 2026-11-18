import { Router } from "express";
import { signedIn } from "../actor.js";
import { ACTIONS } from "../api/actions.js";
import type { TicketService } from "../tickets/service.js";

// The JSON API's ticket routes, one for each row of the action table in api/actions.ts.
// A route only reads the request, calls the row's service function and sends the answer.
// The service checks the rules and the permissions. signedIn(req) answers 401 when nobody is
// signed in.
export function ticketsRouter(service: TicketService): Router {
  const router = Router();
  for (const action of ACTIONS) {
    router[action.method](action.path, (req, res) => {
      const result = action.run({
        service,
        actor: signedIn(req),
        key: typeof req.params.key === "string" ? req.params.key : "",
        query: req.query,
        body: req.body,
      });
      res.status(action.status ?? 200).json(result);
    });
  }
  return router;
}
