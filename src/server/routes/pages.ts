import { Router, type Request, type Response } from "express";
import { signedIn } from "../actor.js";
import { HttpError, ValidationError } from "../errors.js";
import { can } from "../permissions.js";
import { describeActor, describeEvent, formatTime, STATUS_LABELS } from "../pages/format.js";
import { listQuerySchema, TICKET_STATUSES } from "../tickets/schemas.js";
import { LIST_PAGE_SIZE, type TicketService } from "../tickets/service.js";
import { parse } from "../validation.js";

// The pages. Like the JSON routes, they only read the request, call the ticket service and
// send the answer. The answer is HTML built from a template in views/.

// Passed to every ticket template so it can show labels and times.
const helpers = { statusLabels: STATUS_LABELS, statuses: TICKET_STATUSES, formatTime };

// What the reply form holds: the kind chosen, the text typed, and a message if it was refused.
type EntryForm = { kind: string; body: string; error?: string };
const emptyEntry: EntryForm = { kind: "reply", body: "" };

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

  /** Renders the ticket page: the ticket, its conversation, its history and its controls. */
  function showTicket(req: Request, res: Response, status: number, entry: EntryForm): void {
    const actor = signedIn(req);
    const ticket = service.getTicket(req.params.key as string, actor);
    const entries = service.listEntries(ticket.key, actor);
    const history = service.listEvents(ticket.key, actor).map((event) => ({
      when: event.created_at,
      what: describeEvent(event),
      who: describeActor(event),
    }));
    const allowed = service.allowedActions(ticket, actor);
    res.status(status).render("ticket-show", {
      ...helpers,
      title: ticket.key,
      ticket,
      entries,
      history,
      allowed,
      entry,
    });
  }

  router.get("/", (_req, res) => {
    res.redirect("/tickets");
  });

  router.get("/tickets", (req, res) => {
    const actor = signedIn(req);
    const { status, page } = parse(listQuerySchema, req.query);
    const current = status ?? "all";
    const pageNumber = page ?? 1;
    const tickets = service.listTickets(current, actor, pageNumber);
    res.render("ticket-list", {
      ...helpers,
      title: "Tickets",
      current,
      tickets,
      // A full page means there may be older tickets on the next one.
      nextPage: tickets.length === LIST_PAGE_SIZE ? pageNumber + 1 : null,
      showArchivedFilter: can(actor, "list_archived"),
    });
  });

  // Registered before "/tickets/:key" so that "new" is not read as a ticket key.
  router.get("/tickets/new", (req, res) => {
    signedIn(req);
    res.render("ticket-form", { ...newForm, values: emptyForm, errors: {} });
  });

  router.post("/tickets", (req, res) => {
    const actor = signedIn(req);
    const values = readTicketForm(req.body);
    try {
      // The service checks the rules. A browser sends an empty box as "", and for the
      // optional link that means "not given".
      const ticket = service.createTicket(
        { ...values, where_url: values.where_url === "" ? undefined : values.where_url },
        actor,
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
    showTicket(req, res, 200, emptyEntry);
  });

  // Adds a reply or a note from the form under the conversation.
  router.post("/tickets/:key/entries", (req, res) => {
    const actor = signedIn(req);
    const entry = { kind: asText(req.body?.kind) || "reply", body: asText(req.body?.body) };
    try {
      const ticket = service.getTicket(req.params.key, actor);
      service.addEntry(req.params.key, entry, actor);
      res.redirect(303, `/tickets/${ticket.key}#conversation`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      // Show the ticket again with what was typed and the message under the box.
      showTicket(req, res, 400, {
        ...entry,
        error: err.fieldErrors.body?.join(" ") ?? err.message,
      });
    }
  });
  // The edit form is the new ticket form, filled in with the ticket as it is now.
  router.get("/tickets/:key/edit", (req, res) => {
    const actor = signedIn(req);
    const ticket = service.getTicket(req.params.key, actor);
    // An archived ticket cannot be saved, so do not offer a form for it.
    if (!service.allowedActions(ticket, actor).edit) {
      res.redirect(303, `/tickets/${ticket.key}`);
      return;
    }
    const values = {
      title: ticket.title,
      description: ticket.description,
      where_url: ticket.where_url ?? "",
      fix_check: ticket.fix_check ?? "",
    };
    res.render("ticket-form", { ...editForm(ticket.key), values, errors: {} });
  });

  router.post("/tickets/:key/edit", (req, res) => {
    const actor = signedIn(req);
    const values = readTicketForm(req.body);
    try {
      const ticket = service.editTicket(
        req.params.key,
        { ...values, where_url: values.where_url === "" ? undefined : values.where_url },
        actor,
      );
      res.redirect(303, `/tickets/${ticket.key}`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      // The key is checked before it is put in the form's address.
      const key = service.getTicket(req.params.key, actor).key;
      res.status(400).render("ticket-form", { ...editForm(key), values, errors: err.fieldErrors });
    }
  });

  // Archiving asks first, on a page of its own, because for a customer it cannot be undone.
  router.get("/tickets/:key/archive", (req, res) => {
    const actor = signedIn(req);
    const ticket = service.getTicket(req.params.key, actor);
    // Already archived: there is nothing to ask, so show the ticket.
    if (ticket.archived_at !== null) {
      res.redirect(303, `/tickets/${ticket.key}`);
      return;
    }
    if (!service.allowedActions(ticket, actor).archive) {
      throw new HttpError(403, "forbidden", "You are not allowed to do that.");
    }
    res.render("ticket-archive", {
      title: `Archive ${ticket.key}`,
      ticket,
      canSeeArchived: can(actor, "list_archived"),
    });
  });

  router.post("/tickets/:key/archive", (req, res) => {
    const actor = signedIn(req);
    service.archiveTicket(req.params.key, actor);
    // Back to the list: for a customer an archived ticket has no page any more.
    res.redirect(303, "/tickets");
  });

  // Permanent deletion asks for the key to be typed, on a page of its own.
  router.get("/tickets/:key/delete", (req, res) => {
    const actor = signedIn(req);
    const ticket = service.getTicket(req.params.key, actor);
    if (!service.allowedActions(ticket, actor).delete) {
      throw new HttpError(403, "forbidden", "You are not allowed to do that.");
    }
    res.render("ticket-delete", { title: `Delete ${ticket.key}`, ticket, error: null });
  });

  router.post("/tickets/:key/delete", (req, res) => {
    const actor = signedIn(req);
    try {
      const key = service.getTicket(req.params.key, actor).key;
      const { filesCleaned } = service.deleteTicket(req.params.key, req.body, actor);
      res.render("ticket-deleted", { title: `${key} deleted`, key, filesCleaned });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const ticket = service.getTicket(req.params.key, actor);
      res.status(400).render("ticket-delete", {
        title: `Delete ${ticket.key}`,
        ticket,
        error: err.message,
      });
    }
  });

  router.post("/tickets/:key/agreed-check", (req, res) => {
    const ticket = service.agreeCheck(req.params.key, req.body, signedIn(req));
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/change-link", (req, res) => {
    const ticket = service.linkChange(req.params.key, req.body, signedIn(req));
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/ready", (req, res) => {
    const ticket = service.markReady(req.params.key, req.body, signedIn(req));
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/answer", (req, res) => {
    const ticket = service.answer(req.params.key, req.body, signedIn(req));
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/take", (req, res) => {
    const ticket = service.takeTicket(req.params.key, signedIn(req));
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/release", (req, res) => {
    const ticket = service.releaseTicket(req.params.key, signedIn(req));
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/restore", (req, res) => {
    const actor = signedIn(req);
    const ticket = service.restoreTicket(req.params.key, actor);
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/status", (req, res) => {
    const actor = signedIn(req);
    const ticket = service.changeStatus(req.params.key, req.body, actor);
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  return router;
}
