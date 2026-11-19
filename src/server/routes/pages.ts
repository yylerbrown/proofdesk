import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Actor } from "../actor.js";
import { DEMO_ACTORS, signedIn } from "../actor.js";
import { RECORDED_SAMPLE_KEY } from "../demo.js";
import { forbidden, HttpError, onTicketPage, ValidationError } from "../errors.js";
import { can } from "../permissions.js";
import {
  confirmedAt,
  customerSaysNotFixed,
  describeActor,
  describeEvent,
  formatTime,
  STATUS_LABELS,
  timeAgo,
  reportFields,
  waitingOn,
} from "../pages/format.js";
import {
  fileOnce,
  newFormId,
  readFormId,
  formMatchesTicket,
  ticketFiledWith,
} from "../pages/form-id.js";
import { LIST_ORDER_LABELS, noMatchWords, readListPageQuery } from "../pages/list-query.js";
import { sameText, type ListOrder } from "../tickets/schemas.js";
import { statusControl } from "../pages/status-control.js";
import { rememberSaved, takeProblem, takeSaved, type SavedKey } from "../pages/saved.js";
import { RESOLVE_REASON_LABELS, TICKET_STATUSES } from "../tickets/schemas.js";
import { LIST_PAGE_SIZE, type Ticket, type TicketService } from "../tickets/service.js";

// The pages. Like the JSON routes, they only read the request, call the ticket service and
// send the answer. The answer is HTML built from a template in views/.

// Passed to every ticket template so it can show labels and times.
const helpers = {
  statusLabels: STATUS_LABELS,
  statuses: TICKET_STATUSES,
  formatTime,
  timeAgo,
  reportFields,
};

// What the reply form holds: the kind chosen, the text typed, and a message if it was refused.
type EntryForm = { kind: string; body: string; error?: string };

// A refused form on the ticket page: which one, the message, and a comment to keep.
type Problem = {
  form:
    | "answer"
    | "agreedCheck"
    | "changeLink"
    | "ready"
    | "evidence"
    | "reopen"
    | "handOff"
    | "resolve";
  message: string;
  comment: string;
  /** What was typed in the form, so it can be shown again. */
  values?: Record<string, string>;
  /** The evidence boxes that were ticked, so they are ticked again. */
  evidenceIds?: string[];
  /** The box that gets focus when the page comes back, so the visitor lands on the error. */
  focus?: string;
};

// The boxes of each form on the ticket page, in the order the page draws them.
const FORM_FIELDS: Record<Problem["form"], string[]> = {
  answer: ["comment"],
  agreedCheck: ["agreed_check"],
  changeLink: ["change_url"],
  ready: ["try_url", "tried", "result", "response"],
  evidence: ["summary", "link"],
  reopen: ["reason"],
  handOff: ["to"],
  resolve: ["reason", "duplicate_of", "note"],
};

// The forms on the ticket page that carry the ticket's version and show what was typed again
// when they are drawn after a refusal for an old version.
const KEEPS_TEXT = new Set<Problem["form"]>(["ready", "reopen", "resolve"]);

/** The box a refused form should focus: the first one with a message, or else its first box. */
function focusField(form: Problem["form"], fieldErrors: Record<string, string[] | undefined>) {
  const fields = FORM_FIELDS[form];
  return fields.find((name) => (fieldErrors[name] ?? []).length > 0) ?? fields[0];
}

/**
 * The sample a demo visitor files when they start the ticket workflow. Made up, like the demo.
 * The page address stays empty: a made-up address would be filed as if it were the visitor's.
 */
const WALKTHROUGH_SAMPLE = {
  title: "The export button downloads an empty file",
  description:
    "When I export this month's report as CSV, the file has the header row and nothing else.",
  where_url: "",
  fix_check: "I export this month's report and the file has every row.",
};

/**
 * On the demo, the next role to view this ticket as, so one ticket can be followed from the
 * customer's words to their Yes: the team after the customer has filed or answered No, and the
 * customer who filed it when the team has it. After the Yes, the list of resolved tickets.
 */
function demoNext(ticket: Ticket, actor: Actor) {
  if (actor.demo !== true || ticket.archived_at !== null) return null;
  if (ticket.status === "resolved") return { resolved: true as const };
  const filer = DEMO_ACTORS.find((person) => person.id === ticket.created_by);
  const team = DEMO_ACTORS.find((person) => person.role === "team");
  if (actor.id === ticket.created_by && ticket.ready_at === null && team !== undefined) {
    return { switchTo: team.id, label: "View this ticket as a team member" };
  }
  if (actor.role !== "customer" && filer !== undefined && filer.id !== actor.id) {
    return { switchTo: filer.id, label: "View this ticket as the customer who filed it" };
  }
  return null;
}

/** The ticket list's filters and order, as they stand in its address. */
type ListFilters = { status: string; owner?: "me" | "none"; q?: string; order?: ListOrder };

/** The address of the ticket list with these filters, leaving out the ones at their default. */
function listHref(filters: ListFilters, page?: number): string {
  const params = new URLSearchParams();
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.q) params.set("q", filters.q);
  if (filters.order && filters.order !== "open_first") params.set("order", filters.order);
  if (page !== undefined) params.set("page", String(page));
  const query = params.toString();
  return query ? `/tickets?${query}` : "/tickets";
}

// A person who pressed "Not now" on the invitation to connect an assistant: kept in their
// browser, so it needs no account setting and no script.
const INVITE_COOKIE = "assistant_invite";
const INVITE_HIDDEN_FOR = 365 * 24 * 60 * 60 * 1000;

/**
 * Where to connect an assistant, for the team only: an admin's connections page, or on the demo
 * the welcome page's own demo connection. Null for a team member, who cannot connect one.
 */
function connectUrl(actor: Actor): string | null {
  if (actor.demo === true) return "/sign-in#connect";
  return can(actor, "manage_connections") ? "/connections" : null;
}

/** The one step a viewer can take now, as the ticket page's primary button. */
type NextStep = {
  label: string;
  /** A form the button submits, or else the place on the page the button leads to. */
  form?: { action: string; fields?: Record<string, string> };
  href?: string;
  /** One line saying what this step is for, after the button. */
  note?: string;
};

/**
 * The step this viewer can take now: take the ticket and start work, start work, then ask the
 * customer to verify. Each is possible when it is shown; null when there is nothing for this
 * viewer to press.
 */
function nextStep(
  ticket: Ticket,
  allowed: ReturnType<TicketService["allowedActions"]>,
): NextStep | null {
  const at = `/tickets/${ticket.key}`;
  if (allowed.takeAndStart) {
    return { label: "Take ticket and start work", form: { action: `${at}/take-and-start` } };
  }
  if (allowed.start) {
    return {
      label: "Start work",
      form: { action: `${at}/status`, fields: { status: "in_progress" } },
    };
  }
  // One press asks the customer. What the owner tried, a page to try and evidence are optional,
  // in the form under "The fix".
  if (allowed.markReady) {
    return {
      label: "Ask the customer to verify",
      form: { action: `${at}/ready` },
      note: 'Sends the customer "Did this fix it?".',
    };
  }
  return null;
}

/** Why the team cannot ask the customer yet, in plain words, or null when that is not the question. */
function askBlockedReason(ticket: Ticket, actor: Actor): string | null {
  if (actor.role === "customer" || actor.readOnly || ticket.archived_at !== null) return null;
  if (ticket.status === "resolved" || ticket.ready_at !== null) return null;
  if (ticket.owner_id === null) return "Take the ticket first.";
  if (ticket.owner_id !== actor.id)
    return `Only ${ticket.owner_name} can ask the customer to verify.`;
  if (ticket.status !== "in_progress") return "Start work first.";
  return null;
}
type TicketAction = (key: string, input: unknown, actor: Actor) => Ticket;

// What each ticket-page form says it saved. The answer form says one thing or the other, and
// reopening says one thing to the customer and another to the team.
const FORM_SAVED: Record<Problem["form"], (input: unknown, actor: Actor) => SavedKey> = {
  agreedCheck: () => "check",
  changeLink: () => "link",
  ready: () => "ready",
  evidence: () => "evidence",
  reopen: (_input, actor) => (actor.role === "customer" ? "reopened" : "reopenedByTeam"),
  handOff: () => "handedOff",
  resolve: () => "resolvedByTeam",
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

// The edit form's boxes, by the words the person sees above each one.
const BOX_NAMES: [keyof typeof emptyForm, string][] = [
  ["title", "Title"],
  ["description", "Description"],
  ["fix_check", "How will we know it's fixed?"],
  ["where_url", "Page where it happened"],
];

/**
 * The names of the boxes whose text differs from the ticket as it is now. They are compared the
 * way a ticket stores them: trimmed, and with a browser's CR LF line breaks the same as plain ones.
 */
function differingBoxes(ticket: Ticket, values: typeof emptyForm): string[] {
  return BOX_NAMES.filter(
    ([field]) => !sameText((ticket[field] ?? "").trim(), values[field].trim()),
  ).map(([, name]) => name);
}

export function pagesRouter(service: TicketService): Router {
  const router = Router();

  // A cheap read for a ticket page left open, which asks it now and then to notice a change made
  // elsewhere. It is registered before the middleware below, so asking never uses up the
  // message a page shows once after a save. Reading is not counted against the write limit.
  router.get("/tickets/:key/version", (req, res) => {
    res.json(service.ticketStamp(req.params.key, signedIn(req)));
  });

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
    // A person's role beside their name, as in the conversation, since the name is theirs to set.
    const roles = service.peopleRoles(events.map((event) => event.actor));
    const history = events.map((event) => ({
      when: event.created_at,
      what: describeEvent(event),
      who: describeActor(event, names),
      role: event.actor_kind === "agent" ? null : (roles.get(event.actor) ?? null),
    }));
    const allowed = service.allowedActions(ticket, actor);
    const evidence = service.listEvidence(ticket.key, actor);
    const agentHelp = service.agentHelp(ticket);
    // Once an assistant is at work on the ticket, the team's message box starts as an internal
    // note, so the assistant's working is never sent to the customer by default.
    const assistantAtWork =
      agentHelp.current !== null || entries.some((item) => item.author_kind === "agent");
    const shownEntry =
      entry === emptyEntry && assistantAtWork && allowed.note ? { ...entry, kind: "note" } : entry;
    // The test spec, and whether to offer the one line that suggests asking an assistant for
    // one: to the team only, who connect assistants. A customer is never pushed to use one.
    const specPanel = {
      key: ticket.key,
      spec: service.getSpec(ticket.key, actor),
      canDecide: allowed.decideSpec,
    };
    // One quiet line under the conversation suggesting the team ask an assistant for a spec,
    // while there is none.
    // On the demo, a visitor's key reads only the sample made for assistants, so the line shows
    // there and nowhere else. On the real site it shows while no assistant has the ticket.
    const specPrompt =
      !specPanel.spec &&
      ticket.archived_at === null &&
      ticket.status !== "resolved" &&
      can(actor, "list_all") &&
      (actor.demo === true ? agentHelp.demoSample : agentHelp.current === null)
        ? {
            key: ticket.key,
            // Once an assistant is connected, the line need not say how to connect one.
            connectUrl:
              actor.demo !== true && agentHelp.candidates.length > 0 ? null : connectUrl(actor),
          }
        : null;
    res.status(status).render("ticket-show", {
      ...helpers,
      title: `${ticket.key}: ${ticket.title}`,
      ticket,
      viewerRole: actor.role,
      viewerId: actor.id,
      askBlocked: askBlockedReason(ticket, actor),
      assistantSignal: service.assistantSignals([ticket], actor).get(ticket.key) ?? null,
      demoNext: demoNext(ticket, actor),
      nextStep: nextStep(ticket, allowed),
      statusRow: statusControl(ticket, allowed, actor),
      recordedRun: service.recordedRunKey() === ticket.key,
      assistantSampleKey: service.assistantSampleKey(),
      recordedSampleKey: RECORDED_SAMPLE_KEY,
      handOffTo: service.handOffCandidates(ticket),
      agentHelp,
      entries,
      history,
      confirmed: confirmedAt(ticket, events),
      notFixed: customerSaysNotFixed(ticket, events),
      evidence,
      specPanel,
      specPrompt,
      allowed,
      resolveReasons: RESOLVE_REASON_LABELS,
      entry: shownEntry,
      problem,
      // What the page's watcher compares with the server's cheap read.
      stamp: service.ticketStamp(ticket.key, actor),
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
        rememberSaved(res, FORM_SAVED[form](req.body, actor));
        res.redirect(303, `/tickets/${ticket.key}`);
      } catch (err) {
        const values: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.body ?? {})) {
          if (typeof value === "string") values[name] = value;
        }
        // Ticked boxes arrive as one text, or as a list when more than one is ticked.
        const evidenceIds = [req.body?.evidence_ids].flat().filter((id) => typeof id === "string");
        // The ticket changed since the page was opened. A form with text typed in it, or with
        // evidence ticked, is shown again on the ticket as it is now, with that kept. Any other
        // press goes back to the ticket with the reason, as for other refusals.
        const firstTyped = FORM_FIELDS[form].find((name) => (values[name] ?? "").trim() !== "");
        const somethingToKeep = firstTyped !== undefined || evidenceIds.length > 0;
        if (
          err instanceof HttpError &&
          err.code === "ticket_changed" &&
          somethingToKeep &&
          KEEPS_TEXT.has(form)
        ) {
          res.locals.refused = onTicketPage(err);
          showTicket(req, res, 409, emptyEntry, {
            form,
            message:
              "What you entered is kept here. Look at the ticket as it is now, then send again.",
            comment: asText(req.body?.comment ?? req.body?.reason),
            values,
            evidenceIds,
            focus: firstTyped,
          });
          return;
        }
        if (!(err instanceof ValidationError)) throw err;
        const message = Object.values(err.fieldErrors).flat()[0] ?? err.message;
        showTicket(req, res, 400, emptyEntry, {
          form,
          message,
          comment: asText(req.body?.comment ?? req.body?.reason),
          values,
          evidenceIds,
          focus: focusField(form, err.fieldErrors),
        });
      }
    };
  }

  router.get("/", (_req, res) => {
    res.redirect("/tickets");
  });

  router.get("/tickets", (req, res) => {
    const actor = signedIn(req);
    const query = readListPageQuery(req.query);
    // A filter this viewer cannot use, such as Archived for a customer after a role switch or
    // from a bookmark, shows their whole list instead of a refusal.
    const current =
      query.status === "archived" && !can(actor, "list_archived") ? "all" : query.status;
    // A customer's list is their own tickets, so it has no owner filter to keep.
    const owner = actor.role === "customer" ? undefined : query.owner;
    const q = query.q;
    // A ticket key typed into the search, such as "sup-3", opens that ticket when this viewer
    // may see it. Any other text, another customer's key included, is an ordinary search.
    const typedKey = q === undefined ? null : service.visibleKey(q, actor);
    if (typedKey !== null) {
      res.redirect(`/tickets/${typedKey}`);
      return;
    }
    const pageNumber = query.page;
    const order = query.order;
    const tickets = service.listTickets(current, actor, pageNumber, { owner, q }, order);
    // Beside each status filter: how many tickets it holds with the same owner filter and search.
    const counts = service.countTickets(actor, { owner, q });
    // Every link on the list keeps the other filters, so a filtered view can be shared.
    const filters: ListFilters = { status: current, owner, q, order };
    const signals = service.assistantSignals(tickets, actor);
    const reopened =
      actor.role === "customer" ? new Set<string>() : service.reopenedByCustomer(tickets);
    // The invitation to bring an assistant: for the team only, until one is connected. On the
    // demo every visitor gets their own connection, so it always invites.
    const connected = actor.demo === true ? 0 : service.connectedAssistants();
    // The read-only admin preview can connect nothing, so it is not invited.
    const invite =
      actor.role === "customer" || actor.readOnly === true
        ? null
        : connected > 0
          ? { connected, manage: can(actor, "manage_connections") }
          : req.cookies?.[INVITE_COOKIE] === "hidden"
            ? null
            : { connected: 0, connectUrl: connectUrl(actor) };
    res.render("ticket-list", {
      ...helpers,
      title:
        current !== "all"
          ? `${FILTER_TITLES[current]} tickets`
          : actor.role === "customer"
            ? "My tickets"
            : "All tickets",
      current,
      tickets: tickets.map((ticket) => ({
        ...ticket,
        // What an assistant said it needs is what the team needs to see first.
        waiting: signals.has(ticket.key)
          ? `${signals.get(ticket.key)!.label} ${signals.get(ticket.key)!.text}`
          : waitingOn(ticket, actor.role, reopened.has(ticket.key)),
      })),
      viewerRole: actor.role,
      // A full page means there may be older tickets on the next one.
      nextPage: tickets.length === LIST_PAGE_SIZE ? listHref(filters, pageNumber + 1) : null,
      filters,
      href: (change: Partial<ListFilters>) => listHref({ ...filters, ...change }),
      // Who owns a ticket is the team's question; a customer's list is their own tickets.
      ownerFilters: actor.role !== "customer",
      narrowed: owner !== undefined || q !== undefined,
      noMatch: noMatchWords(current, owner, q),
      counts,
      orders: LIST_ORDER_LABELS,
      showArchivedFilter: can(actor, "list_archived"),
      invite,
    });
  });

  // "Not now" on the invitation to connect an assistant hides it in this browser.
  router.post("/assistant-invite/hide", (req, res) => {
    signedIn(req);
    res.cookie(INVITE_COOKIE, "hidden", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: INVITE_HIDDEN_FOR,
      path: "/",
    });
    res.redirect(303, "/tickets");
  });

  // Registered before "/tickets/:key" so that "new" is not read as a ticket key.
  router.get("/tickets/new", (req, res) => {
    const actor = signedIn(req);
    // The demo's admin preview may not file a ticket: say so instead of offering a form.
    if (actor.readOnly === true) {
      res.render("ticket-form", { ...newForm, readOnly: true, values: emptyForm, errors: {} });
      return;
    }
    // Each new form gets its own one-time id in its address, so Back after filing opens the
    // same form again, and the page can say it was filed.
    const formId = readFormId(req.query.form);
    if (formId === null) {
      const address = new URLSearchParams();
      if (req.query.try === "1") address.set("try", "1");
      address.set("form", newFormId());
      res.redirect(303, `/tickets/new?${address}`);
      return;
    }
    // On the demo, the ticket workflow starts from a filled-in sample the visitor can change.
    const sample = actor.demo === true && req.query.try === "1";
    res.render("ticket-form", {
      ...newForm,
      formId,
      alreadyFiled: ticketFiledWith(service, actor, formId),
      values: sample ? WALKTHROUGH_SAMPLE : emptyForm,
      // The form says so, since sample text in the boxes looks like text the visitor typed.
      sample,
      errors: {},
    });
  });

  router.post("/tickets", (req, res) => {
    const actor = signedIn(req);
    const values = readTicketForm(req.body);
    const formId = readFormId(req.body?.form);
    try {
      let filedNow = false;
      // The service checks the rules. A browser sends an empty box as "", and for the
      // optional link that means "not given".
      const fileTicket = () => {
        filedNow = true;
        return service.createTicket(
          { ...values, where_url: values.where_url === "" ? undefined : values.where_url },
          actor,
        );
      };
      // A form with an id files once. Sent again, it gets back the ticket it already filed.
      const ticket = formId === null ? fileTicket() : fileOnce(service, actor, formId, fileTicket);
      if (filedNow) {
        // 303 makes the browser fetch the ticket page with GET, so a refresh cannot file it twice.
        rememberSaved(res, "filed");
        res.redirect(303, `/tickets/${ticket.key}`);
      } else if (formMatchesTicket(ticket, values)) {
        // The same form sent twice, for example after Back: open the ticket it filed.
        rememberSaved(res, "alreadyFiled");
        res.redirect(303, `/tickets/${ticket.key}`);
      } else {
        // The same form sent again with changed text: file nothing, and keep what was typed.
        res.status(409).render("ticket-form", {
          ...newForm,
          formId,
          alreadyFiled: ticket,
          values,
          errors: {},
        });
      }
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      // Show the form again with what was typed and one message under each wrong box.
      res
        .status(400)
        .render("ticket-form", { ...newForm, formId, values, errors: err.fieldErrors });
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
    res.render("ticket-form", {
      ...editForm(ticket.key),
      values,
      errors: {},
      checkLocked: ticket.created_by !== actor.id,
      version: ticket.version,
    });
  });

  router.post("/tickets/:key/edit", (req, res) => {
    const actor = signedIn(req);
    const values = readTicketForm(req.body);
    const expectedVersion = asText(req.body?.expected_version);
    try {
      const ticket = service.editTicket(
        req.params.key,
        {
          ...values,
          where_url: values.where_url === "" ? undefined : values.where_url,
          expected_version: expectedVersion,
        },
        actor,
      );
      rememberSaved(res, "edited");
      res.redirect(303, `/tickets/${ticket.key}`);
    } catch (err) {
      const changed = err instanceof HttpError && err.code === "ticket_changed";
      if (!(err instanceof ValidationError) && !changed) throw err;
      // The ticket as it is now. Its key is checked before it is put in the form's address.
      const current = service.getTicket(req.params.key, actor);
      const checkLocked = current.created_by !== actor.id;
      // What the person typed stays. A check they may not change shows as it is now.
      const shown = checkLocked ? { ...values, fix_check: current.fix_check ?? "" } : values;
      const errors = err instanceof ValidationError ? err.fieldErrors : {};
      res.status(changed ? 409 : 400).render("ticket-form", {
        ...editForm(current.key),
        values: shown,
        errors,
        // The boxes whose text on the ticket now differs from what the form holds, so a second
        // save does not put old text back unnoticed.
        differ: changed ? differingBoxes(current, shown) : [],
        // The hidden version has no box of its own, so a problem with it is said at the top.
        versionUnreadable: errors.expected_version !== undefined,
        checkLocked,
        // After a refusal for a newer version, the form carries that version, so saving again
        // is a choice made with the change in view. After a mistake in a box, it keeps its own.
        version: changed ? current.version : expectedVersion,
        changedElsewhere: changed,
      });
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
      throw forbidden(actor);
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
      throw forbidden(actor);
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
  router.post("/tickets/:key/resolve", ticketForm("resolve", service.resolveWithReason));
  router.post("/tickets/:key/adopt-check", (req, res) => {
    const ticket = service.adoptCheck(req.params.key, signedIn(req), req.body);
    rememberSaved(res, "adopted");
    res.redirect(303, `/tickets/${ticket.key}`);
  });
  router.post("/tickets/:key/withdraw-question", (req, res) => {
    const ticket = service.withdrawQuestionAsked(req.params.key, signedIn(req), req.body);
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
    const ticket = service.endAgentWork(req.params.key, signedIn(req), req.body);
    rememberSaved(res, "agentEnded");
    res.redirect(303, `/tickets/${ticket.key}`);
  });
  router.post("/tickets/:key/take-and-start", (req, res) => {
    const ticket = service.takeAndStart(req.params.key, signedIn(req), req.body);
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
    const ticket = service.takeTicket(req.params.key, signedIn(req), req.body);
    rememberSaved(res, "taken");
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  router.post("/tickets/:key/release", (req, res) => {
    const ticket = service.releaseTicket(req.params.key, signedIn(req), req.body);
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
    if (ticket.status === "new" && before !== "new") rememberSaved(res, "returnedToNew");
    else if (ticket.status !== before) rememberSaved(res, "status");
    res.redirect(303, `/tickets/${ticket.key}`);
  });

  return router;
}
