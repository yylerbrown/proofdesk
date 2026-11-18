import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Actor } from "../actor.js";
import { signedIn } from "../actor.js";
import { HttpError, ValidationError } from "../errors.js";
import { can } from "../permissions.js";
import {
  confirmedAt,
  describeActor,
  describeEvent,
  formatTime,
  STATUS_LABELS,
  timeAgo,
  waitingOn,
} from "../pages/format.js";
import { rememberSaved, takeProblem, takeSaved, type SavedKey } from "../pages/saved.js";
import { listQuerySchema, TICKET_STATUSES } from "../tickets/schemas.js";
import { LIST_PAGE_SIZE, type Ticket, type TicketService } from "../tickets/service.js";
import { parse } from "../validation.js";

// The pages. Like the JSON routes, they only read the request, call the ticket service and
// send the answer. The answer is HTML built from a template in views/.

// Passed to every ticket template so it can show labels and times.
const helpers = { statusLabels: STATUS_LABELS, statuses: TICKET_STATUSES, formatTime, timeAgo };

// What the reply form holds: the kind chosen, the text typed, and a message if it was refused.
type EntryForm = { kind: string; body: string; error?: string };

// A refused form on the ticket page: which one, the message, and a comment to keep.
type Problem = {
  form: "answer" | "agreedCheck" | "changeLink" | "ready" | "evidence" | "reopen" | "handOff";
  message: string;
  comment: string;
  /** What was typed in the form, so it can be shown again. */
  values?: Record<string, string>;
};

/** Why the team cannot ask the customer yet, in plain words, or null when that is not the question. */
function askBlockedReason(ticket: Ticket, actor: Actor): string | null {
  if (actor.role === "customer" || actor.readOnly || ticket.archived_at !== null) return null;
  if (ticket.status === "resolved" || ticket.ready_at !== null) return null;
  if (ticket.owner_id === null) return "Take the ticket first.";
  if (ticket.owner_id !== actor.id)
    return `Only ${ticket.owner_name}, who owns it, asks the customer.`;
  if (ticket.status !== "in_progress") return "Start work first.";
  if (ticket.change_url === null) return "Add the change link first.";
  return null;
}
type TicketAction = (key: string, input: unknown, actor: Actor) => Ticket;

// What each ticket-page form says it saved. The answer form says one thing or the other.
const FORM_SAVED: Record<Problem["form"], (input: unknown) => SavedKey> = {
  agreedCheck: () => "check",
  changeLink: () => "link",
  ready: () => "ready",
  evidence: () => "evidence",
  reopen: () => "reopened",
  handOff: () => "handedOff",
  answer: (input) =>
    (input as Record<string, unknown> | undefined)?.fixed === "yes" ? "fixed" : "notFixed",
};
const emptyEntry: EntryForm = { kind: "reply", body: "" };

const emptyForm = { title: "", description: "", where_url: "", fix_check: "" };

// What differs between the two uses of the ticket form: its heading, where it posts, its button.
const newForm = { title: "New ticket", action: "/tickets", submitLabel: "File ticket" };

function editForm(key: string) {
  return { title: `Edit ${key}`, action: `/tickets/${key}/edit`, submitLabel: "Save changes" };
}

// The heading of each list, for the page title.
const FILTER_TITLES = { ...STATUS_LABELS, all: "All", archived: "Archived" };

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

  // A page opened just after a save says what was saved.
  router.use((req, res, next) => {
    if (req.method === "GET") {
      res.locals.saved = takeSaved(req, res);
      res.locals.refused = takeProblem(req, res);
    }
    next();
  });

  /** Renders the ticket page: the ticket, its conversation, its history and its controls. */
  function showTicket(
    req: Request,
    res: Response,
    status: number,
    entry: EntryForm,
    problem: Problem | null = null,
  ): void {
    const actor = signedIn(req);
    const ticket = service.getTicket(req.params.key as string, actor);
    const entries = service.listEntries(ticket.key, actor);
    const events = service.listEvents(ticket.key, actor);
    const names = service.peopleNames(events.map((event) => event.actor));
    const history = events.map((event) => ({
      when: event.created_at,
      what: describeEvent(event),
      who: describeActor(event, names),
    }));
    const allowed = service.allowedActions(ticket, actor);
    const evidence = service.listEvidence(ticket.key, actor);
    // The test spec, and whether to offer the one line that suggests asking an assistant for
    // one: to the team, who connect assistants, and to every demo visitor, who may.
    const specPanel = {
      key: ticket.key,
      spec: service.getSpec(ticket.key, actor),
      canDecide: allowed.decideSpec,
      // Where to connect an assistant: an admin's connections, or the demo's own button.
      connectUrl: actor.demo === true ? "/sign-in" : "/connections",
      offerPrompt:
        ticket.archived_at === null &&
        ticket.status !== "resolved" &&
        (can(actor, "list_all") || actor.demo === true),
    };
    res.status(status).render("ticket-show", {
      ...helpers,
      title: `${ticket.key}: ${ticket.title}`,
      ticket,
      viewerRole: actor.role,
      viewerId: actor.id,
      askBlocked: askBlockedReason(ticket, actor),
      handOffTo: service.handOffCandidates(ticket),
      agentHelp: service.agentHelp(ticket),
      entries,
      history,
      confirmed: confirmedAt(ticket, events),
      evidence,
      specPanel,
      allowed,
      entry,
      problem,
    });
  }

  /**
   * A form on the ticket page that runs one service function and comes back to the ticket.
   * If the input breaks a rule, the ticket is shown again with the message beside that form,
   * and a comment the customer typed is kept.
   */
  function ticketForm(form: Problem["form"], run: TicketAction): RequestHandler {
    return (req, res) => {
      const actor = signedIn(req);
      try {
        const ticket = run(req.params.key as string, req.body, actor);
        rememberSaved(res, FORM_SAVED[form](req.body));
        res.redirect(303, `/tickets/${ticket.key}`);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        const message = Object.values(err.fieldErrors).flat()[0] ?? err.message;
        const values: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.body ?? {})) {
          if (typeof value === "string") values[name] = value;
        }
        showTicket(req, res, 400, emptyEntry, {
          form,
          message,
          comment: asText(req.body?.comment ?? req.body?.reason),
          values,
        });
      }
    };
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
      title: current === "all" ? "Tickets" : `${FILTER_TITLES[current]} tickets`,
      current,
      tickets: tickets.map((ticket) => ({ ...ticket, waiting: waitingOn(ticket, actor.role) })),
      viewerRole: actor.role,
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
      rememberSaved(res, "filed");
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
      // A reply published from a note carries that note's id.
      const basedOn = asText(req.body?.based_on);
      const added = service.addEntry(
        req.params.key,
        basedOn === "" ? entry : { ...entry, based_on: basedOn },
        actor,
      );
      rememberSaved(res, added.kind === "note" ? "note" : "reply");
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
      rememberSaved(res, "edited");
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
    rememberSaved(res, "archived");
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

  router.post("/tickets/:key/agreed-check", ticketForm("agreedCheck", service.agreeCheck));
  router.post("/tickets/:key/change-link", ticketForm("changeLink", service.linkChange));
  router.post("/tickets/:key/ready", ticketForm("ready", service.markReady));
  router.post("/tickets/:key/answer", ticketForm("answer", service.answer));
  router.post("/tickets/:key/reopen", ticketForm("reopen", service.reopen));
  router.post("/tickets/:key/withdraw-question", (req, res) => {
    const ticket = service.withdrawQuestionAsked(req.params.key, signedIn(req));
    rememberSaved(res, "withdrawn");
    res.redirect(303, `/tickets/${ticket.key}`);
  });
  router.post("/tickets/:key/hand-off", ticketForm("handOff", service.handOff));
  router.post("/tickets/:key/agent", (req, res) => {
    const ticket = service.giveToAgent(req.params.key, req.body, signedIn(req));
    rememberSaved(res, "agentGiven");
    res.redirect(303, `/tickets/${ticket.key}`);
  });
  router.post("/tickets/:key/agent/end", (req, res) => {
    const ticket = service.endAgentWork(req.params.key, signedIn(req));
    rememberSaved(res, "agentEnded");
    res.redirect(303, `/tickets/${ticket.key}`);
  });
  router.post("/tickets/:key/take-and-start", (req, res) => {
    const ticket = service.takeAndStart(req.params.key, signedIn(req));
    rememberSaved(res, "started");
    res.redirect(303, `/tickets/${ticket.key}`);
  });
  // The team attaches evidence from the ticket page. An empty link means none.
  router.post(
    "/tickets/:key/evidence",
    ticketForm("evidence", (key, input, actor) => {
      const fields = { ...(input as Record<string, unknown>) };
      if (fields.link === "") delete fields.link;
      service.addEvidence(key, fields, actor);
      return service.getTicket(key, actor);
    }),
  );

  router.post("/tickets/:key/take", (req, res) => {
    const ticket = service.takeTicket(req.params.key, signedIn(req));
    rememberSaved(res, "taken");
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/release", (req, res) => {
    const ticket = service.releaseTicket(req.params.key, signedIn(req));
    rememberSaved(res, "released");
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/spec/decision", (req, res) => {
    const spec = service.decideSpec(req.params.key, req.body, signedIn(req));
    rememberSaved(res, spec.state === "accepted" ? "specAccepted" : "specDiscarded");
    res.redirect(303, `/tickets/${spec.ticket_key}`);
  });

  router.post("/tickets/:key/restore", (req, res) => {
    const actor = signedIn(req);
    const ticket = service.restoreTicket(req.params.key, actor);
    rememberSaved(res, "restored");
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/status", (req, res) => {
    const actor = signedIn(req);
    const before = service.getTicket(req.params.key, actor).status;
    const ticket = service.changeStatus(req.params.key, req.body, actor);
    if (ticket.status !== before) rememberSaved(res, "status");
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  return router;
}
