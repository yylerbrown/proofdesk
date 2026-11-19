import { Router } from "express";
import { z } from "zod";
import { signedIn } from "../actor.js";
import { STATUS_LABELS } from "../pages/format.js";
import type { TicketService } from "../tickets/service.js";

// The new ticket form asks here, while a title is typed, whether an earlier ticket is like it.
// It is for the pages only, not a row in the API: the title travels in the request body, never
// in the address, so a draft never lands in an access log. Nothing is stored. The answer is
// {"similar": null} or {"similar": {"key", "title", "status"}}, with the status as the list
// shows it.

export const SIMILAR_PATH = "/tickets/similar";

// A body without a title, or with something else in its place, asks about nothing.
const similarForm = z.object({ title: z.string() });

export function similarRouter(service: TicketService): Router {
  const router = Router();
  router.post(SIMILAR_PATH, (req, res) => {
    const actor = signedIn(req);
    const form = similarForm.safeParse(req.body);
    const found = form.success ? service.similarTicket(actor, form.data.title) : null;
    res.json({
      similar:
        found === null
          ? null
          : { key: found.key, title: found.title, status: STATUS_LABELS[found.status] },
    });
  });
  return router;
}
