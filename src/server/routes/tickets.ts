import { Router } from "express";
import { signedIn } from "../actor.js";
import { ACTIONS, nextCursor } from "../api/actions.js";
import type { ConnectionService } from "../connections/service.js";
import { HttpError } from "../errors.js";
import type { TicketService } from "../tickets/service.js";

// The JSON API's ticket routes, one for each row of the action table in api/actions.ts.
// A route only reads the request, calls the row's service function and sends the answer.
// The service checks the rules and the permissions. signedIn(req) answers 401 when nobody is
// signed in. A write sent with an Idempotency-Key header is done once; a list says where its
// next page is in a Link header.
export function ticketsRouter(service: TicketService, connections: ConnectionService): Router {
  const router = Router();
  for (const action of ACTIONS) {
    router[action.method](action.path, (req, res) => {
      const actor = signedIn(req);
      const key = typeof req.params.key === "string" ? req.params.key : "";
      const call = () => action.run({ service, actor, key, query: req.query, body: req.body });
      const idempotencyKey = req.get("Idempotency-Key");
      // What an agent asks for is recorded, done or refused, for its connection's activity.
      const record = (outcome: "done" | "refused" | "failed", code: string | null) =>
        connections.record(actor, {
          door: "api",
          action: action.name,
          ticketKey: key,
          idempotencyKey,
          outcome,
          code,
        });
      let result: unknown;
      try {
        result =
          action.method === "get"
            ? call()
            : service.once(actor, idempotencyKey, action.name, key, req.body, call);
      } catch (err) {
        record(
          err instanceof HttpError && err.status < 500 ? "refused" : "failed",
          err instanceof HttpError ? err.code : "internal_error",
        );
        throw err;
      }
      record("done", null);
      if (action.paged && Array.isArray(result)) {
        const next = nextCursor(req.query, result);
        if (next !== null) {
          // The next page keeps the same filters.
          const params = new URLSearchParams();
          for (const name of ["status", "owner", "q"]) {
            const value = req.query[name];
            if (typeof value === "string" && value !== "") params.set(name, value);
          }
          params.set("cursor", next);
          res.set("Link", `</api${action.path}?${params}>; rel="next"`);
        }
      }
      res.status(action.status ?? 200).json(result);
    });
  }
  return router;
}
