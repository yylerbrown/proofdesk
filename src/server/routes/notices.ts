import { Router } from "express";
import { signedIn } from "../actor.js";
import type { Db } from "../db.js";
import { noticeStateWords, noticesNewestFirst } from "../notify/view.js";
import { emailBodyParts } from "../pages/email-body.js";
import { formatTime } from "../pages/format.js";
import { parseKey } from "../tickets/keys.js";
import type { TicketService } from "../tickets/service.js";

// The notices page: the email notices one ticket sent, or would have sent, as the viewer may
// see them. It only reads. The ticket service decides who may read the ticket, so a ticket the
// viewer may not read gets the same Not found as the ticket page.

export function noticesRouter(service: TicketService, db: Db, ticketPrefix: string): Router {
  const router = Router();
  router.get("/tickets/:key/notices", (req, res) => {
    const viewer = signedIn(req);
    const ticket = service.getTicket(req.params.key, viewer);
    const ticketId = parseKey(ticketPrefix, ticket.key)!;
    const notices = noticesNewestFirst(db, ticketId, viewer);
    const names = service.peopleNames(notices.map((notice) => notice.recipient_id));
    res.render("notices", {
      title: "Emails sent about this ticket",
      ticket,
      forTeam: viewer.role !== "customer",
      formatTime,
      notices: notices.map((notice) => ({
        to:
          notice.recipient_id === viewer.id ? "You" : (names.get(notice.recipient_id) ?? "Someone"),
        // When it went out, or when it was written if it never did.
        when: notice.sent_at ?? notice.created_at,
        state: noticeStateWords(notice),
        subject: notice.subject,
        bodyParts: emailBodyParts(notice.body, ticket.key),
      })),
    });
  });
  return router;
}
