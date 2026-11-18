import { Router } from "express";
import { ValidationError } from "../errors.js";
import { describeActor, describeEvent, formatTime, STATUS_LABELS } from "../pages/format.js";
import { listQuerySchema, TICKET_STATUSES } from "../tickets/schemas.js";
import type { TicketService } from "../tickets/service.js";
import { parse } from "../validation.js";

// The pages. Like the JSON routes, they only read the request, call the ticket service and
// send the answer. The answer is HTML built from a template in views/.

// Passed to every ticket template so it can show labels and times.
const helpers = { statusLabels: STATUS_LABELS, statuses: TICKET_STATUSES, formatTime };

const emptyForm = { title: "", description: "", where_url: "", fix_check: "" };

// What differs between the two uses of the ticket form: its heading, where it posts, its button.
const newForm = { title: "New ticket", action: "/tickets", submitLabel: "File ticket" };

function editForm(key: string) {
  return { title: `Edit ${key}`, action: `/tickets/${key}/edit`, submitLabel: "Save changes" };
}

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
    res.render("ticket-form", { ...newForm, values: emptyForm, errors: {} });
  });

  router.post("/tickets", (req, res) => {
    const values = readTicketForm(req.body);
    try {
      // The service checks the rules. A browser sends an empty box as "", and for the
      // optional link that means "not given".
      const ticket = service.createTicket(
        { ...values, where_url: values.where_url === "" ? undefined : values.where_url },
        req.actor,
      );
      // 303 makes the browser fetch the ticket page with GET, so a refresh cannot file it twice.
      res.redirect(303, `/tickets/${ticket.key}`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      // Show the form again with what was typed and one message under each wrong box.
      res.status(400).render("ticket-form", { ...newForm, values, errors: err.fieldErrors });
    }
  });

  router.get("/tickets/:key", (req, res) => {
    const ticket = service.getTicket(req.params.key);
    const history = service.listEvents(req.params.key).map((event) => ({
      when: event.created_at,
      what: describeEvent(event),
      who: describeActor(event),
    }));
    res.render("ticket-show", { ...helpers, title: ticket.key, ticket, history });
  });

  // The edit form is the new ticket form, filled in with the ticket as it is now.
  router.get("/tickets/:key/edit", (req, res) => {
    const ticket = service.getTicket(req.params.key);
    const values = {
      title: ticket.title,
      description: ticket.description,
      where_url: ticket.where_url ?? "",
      fix_check: ticket.fix_check ?? "",
    };
    res.render("ticket-form", { ...editForm(ticket.key), values, errors: {} });
  });

  router.post("/tickets/:key/edit", (req, res) => {
    const values = readTicketForm(req.body);
    try {
      const ticket = service.editTicket(
        req.params.key,
        { ...values, where_url: values.where_url === "" ? undefined : values.where_url },
        req.actor,
      );
      res.redirect(303, `/tickets/${ticket.key}`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      // The key is checked before it is put in the form's address.
      const key = service.getTicket(req.params.key).key;
      res.status(400).render("ticket-form", { ...editForm(key), values, errors: err.fieldErrors });
    }
  });

  router.post("/tickets/:key/archive", (req, res) => {
    const ticket = service.archiveTicket(req.params.key, req.actor);
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/restore", (req, res) => {
    const ticket = service.restoreTicket(req.params.key, req.actor);
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/status", (req, res) => {
    const ticket = service.changeStatus(req.params.key, req.body, req.actor);
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  return router;
}
