import { Router } from "express";
import { signedIn } from "../actor.js";
import { ACTIONS, nextCursor } from "../api/actions.js";
import type { TicketService } from "../tickets/service.js";

// The JSON API's ticket routes, one for each row of the action table in api/actions.ts.
// A route only reads the request, calls the row's service function and sends the answer.
// The service checks the rules and the permissions. signedIn(req) answers 401 when nobody is
// signed in. A write sent with an Idempotency-Key header is done once; a list says where its
// next page is in a Link header.
export function ticketsRouter(service: TicketService): Router {
  const router = Router();
  for (const action of ACTIONS) {
    router[action.method](action.path, (req, res) => {
      const actor = signedIn(req);
      const key = typeof req.params.key === "string" ? req.params.key : "";
      const call = () => action.run({ service, actor, key, query: req.query, body: req.body });
      const result =
        action.method === "get"
          ? call()
          : service.once(actor, req.get("Idempotency-Key"), action.name, key, req.body, call);
      if (action.paged && Array.isArray(result)) {
        const next = nextCursor(req.query, result);
        if (next !== null) {
          const status =
            typeof req.query.status === "string"
              ? `status=${encodeURIComponent(req.query.status)}&`
              : "";
          res.set("Link", `</api${action.path}?${status}cursor=${next}>; rel="next"`);
        }
      }
      res.status(action.status ?? 200).json(result);
    });
  }
  return router;
}
