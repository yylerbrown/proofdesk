import { Router } from "express";
import { z } from "zod";
import { describeEvent, formatTime, STATUS_LABELS } from "../pages/format.js";
import {
  changeStatusSchema,
  createTicketSchema,
  listQuerySchema,
  TICKET_STATUSES,
} from "../tickets/schemas.js";
import type { TicketService } from "../tickets/service.js";
import { parse } from "../validation.js";

// The pages. Like the JSON routes, they only read the request, call the ticket service and
// send the answer. The answer is HTML built from a template in views/.

// Passed to every ticket template so it can show labels and times.
const helpers = { statusLabels: STATUS_LABELS, statuses: TICKET_STATUSES, formatTime };

const emptyForm = { title: "", description: "", where_url: "", fix_check: "" };

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Reads the four boxes of the ticket form as text. A missing box counts as empty. */
function readTicketForm(body: Record<string, unknown> | undefined): typeof emptyForm {
  return {
    title: asText(body?.title),
    description: asText(body?.description),
    where_url: asText(body?.where_url),
    fix_check: asText(body?.fix_check),
  };
}

export function pagesRouter(service: TicketService): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.redirect("/tickets");
  });

  router.get("/tickets", (req, res) => {
    const { status } = parse(listQuerySchema, req.query);
    const current = status ?? "all";
    res.render("ticket-list", {
      ...helpers,
      title: "Tickets",
      current,
      tickets: service.listTickets(current),
    });
  });

  // Registered before "/tickets/:key" so that "new" is not read as a ticket key.
  router.get("/tickets/new", (_req, res) => {
    res.render("ticket-new", { title: "New ticket", values: emptyForm, errors: {} });
  });

  router.post("/tickets", (req, res) => {
    const values = readTicketForm(req.body);
    // A browser sends an empty box as "". For the optional link that means "not given".
    const result = createTicketSchema.safeParse({
      ...values,
      where_url: values.where_url === "" ? undefined : values.where_url,
    });
    if (!result.success) {
      // Show the form again with what was typed and one message under each wrong box.
      const errors = z.flattenError(result.error).fieldErrors;
      res.status(400).render("ticket-new", { title: "New ticket", values, errors });
      return;
    }
    const ticket = service.createTicket(result.data, req.actor);
    // 303 makes the browser fetch the ticket page with GET, so a refresh cannot file it twice.
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.get("/tickets/:key", (req, res) => {
    const ticket = service.getTicket(req.params.key);
    const history = service.listEvents(req.params.key).map((event) => ({
      when: event.created_at,
      what: describeEvent(event),
      who: event.actor,
    }));
    res.render("ticket-show", { ...helpers, title: ticket.key, ticket, history });
  });

  router.post("/tickets/:key/status", (req, res) => {
    const { status } = parse(changeStatusSchema, req.body);
    const ticket = service.changeStatus(req.params.key, status, req.actor);
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  return router;
}
