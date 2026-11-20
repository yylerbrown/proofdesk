import { randomInt } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { Actor } from "../actor.js";
import { DEMO_ACTORS, signedIn } from "../actor.js";
import { RECORDED_ASSISTANT, RECORDED_SAMPLE_KEY } from "../demo.js";
import { errorBody, forbidden, HttpError, onTicketPage, ValidationError } from "../errors.js";
import { can } from "../permissions.js";
import {
  afterLeadWord,
  cardLine,
  confirmedAt,
  CUSTOMER_ANSWER_TAG,
  describeActor,
  describeEvent,
  firstParagraph,
  formatDay,
  paragraphs,
  formatTime,
  notFixedCard,
  STATUS_LABELS,
  timeAgo,
  reportFields,
  roleAfterName,
  turnTag,
  markedFixed,
} from "../pages/format.js";
import {
  fileOnce,
  newFormId,
  readFormId,
  formMatchesTicket,
  ticketFiledWith,
} from "../pages/form-id.js";
import { fingerprint } from "../pages/loaded-text.js";
import { messageRefusalLine, ticketFormPictureLine } from "../pages/picture-refusal.js";
import { sendPicturesFewAtOnce } from "../pictures/sending.js";
import { keepUploaderToken, picturesOf, uploaderToken, viewerToken } from "../pictures/upload.js";
import {
  noMatchWords,
  readListPageQuery,
  recentResolvedCutoff,
  sortHeaders,
  type ListPageFilter,
  type ResolvedAge,
} from "../pages/list-query.js";
import { sameText, type ListSort } from "../tickets/schemas.js";
import { rememberBulkOutcome, takeBulkOutcome } from "../pages/bulk-outcome.js";
import { lastPage, listPages } from "../pages/list-pages.js";
import {
  addToBox,
  firstInBox,
  proofChoices,
  SAMPLE_PROOFS,
  waitingLine,
} from "../pages/proof-step.js";
import { customerStanding } from "../pages/standing.js";
import { statusControl } from "../pages/status-control.js";
import { DESCRIPTION_LIMIT, withHowFarOver } from "../pages/text-limit.js";
import {
  filedMessage,
  rememberProblem,
  rememberSaved,
  SAVED_MESSAGES,
  switchedMessage,
  takeProblem,
  takeSaved,
  type SavedKey,
} from "../pages/saved.js";
import { RESOLVE_REASON_LABELS, TICKET_STATUSES } from "../tickets/schemas.js";
import type { SimilarTicket } from "../tickets/reads.js";
import type { Ticket, TicketService } from "../tickets/service.js";

// The pages. Like the JSON routes, they only read the request, call the ticket service and
// send the answer. The answer is HTML built from a template in views/.

// Passed to every ticket template so it can show labels and times.
const helpers = {
  statusLabels: STATUS_LABELS,
  statuses: TICKET_STATUSES,
  formatTime,
  formatDay,
  timeAgo,
  reportFields,
  firstParagraph,
  afterLeadWord,
  roleAfterName,
  paragraphs,
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
    | "reopen"
    | "handOff"
    | "resolve"
    | "markFixed"
    | "verify";
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
  // The page has one box, the message; the API also takes the other three.
  ready: ["response", "try_url", "tried", "result"],
  reopen: ["reason"],
  handOff: ["to"],
  resolve: ["reason", "duplicate_of", "note", "fixed_in"],
  // The next step "Mark fixed and tell the customer" is one button with no box.
  markFixed: [],
  // The step after filing: what would prove it is fixed.
  verify: ["words"],
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
 * What would prove it is fixed is the next step, after filing, where three sample ways wait.
 */
const WALKTHROUGH_SAMPLE = {
  title: "The export button downloads an empty file",
  description:
    "When I export this month's report as CSV, the file has the header row and nothing else.",
  where_url: "",
  fix_check: "",
};

/**
 * True for a demo ticket that is still the welcome card's sample, word for word. Such a ticket
 * has no real fix to make, so its page says the sample skips it.
 */
function isWalkthroughSample(ticket: Ticket, actor: Actor): boolean {
  return (
    actor.demo === true &&
    ticket.title === WALKTHROUGH_SAMPLE.title &&
    ticket.description === WALKTHROUGH_SAMPLE.description
  );
}

/**
 * On the demo, the next role to view this ticket as, so one ticket can be followed from the
 * customer's words to their Yes: the team after the customer has filed or said No, and the
 * customer who filed it once the team has marked it fixed (or asked them), so the team's own next
 * step comes first. Nothing once the customer has confirmed it or the team resolved it otherwise.
 */
function demoNext(ticket: Ticket, actor: Actor) {
  if (actor.demo !== true || ticket.archived_at !== null) return null;
  const filer = DEMO_ACTORS.find((person) => person.id === ticket.created_by);
  const team = DEMO_ACTORS.find((person) => person.role === "team");
  // The customer has been told it is fixed, or asked, and has not answered yet.
  const asked = ticket.status !== "resolved" && ticket.ready_at !== null;
  if (
    (markedFixed(ticket) || asked) &&
    actor.role !== "customer" &&
    filer !== undefined &&
    filer.id !== actor.id
  ) {
    return { switchTo: filer.id, label: "View this ticket as the customer who filed it" };
  }
  if (ticket.status === "resolved") return null;
  // Only a customer is offered the team's side: a team member who filed it is on that side.
  if (
    actor.role === "customer" &&
    actor.id === ticket.created_by &&
    ticket.ready_at === null &&
    team !== undefined
  ) {
    return { switchTo: team.id, label: "View this ticket as a team member" };
  }
  return null;
}

/**
 * The ticket list's filters and sort, as they stand in its address. Which resolved tickets
 * "Resolved" shows by age is left out at its default, any age.
 */
type ListFilters = {
  status: string;
  owner?: "me" | "none";
  q?: string;
  sort: ListSort;
  resolved?: Exclude<ResolvedAge, "any">;
};

/** The list's filters as read from its address, with the page. */
type ListView = ListFilters & { status: ListPageFilter; page: number };

/** What the list's bar for changing ticked tickets shows: after a refusal, what was chosen. */
type BulkForm = { ticked: Set<string>; values: Record<string, string>; message: string | null };
const emptyBulkForm: BulkForm = { ticked: new Set(), values: {}, message: null };

/** The address of the ticket list with these filters, leaving out the ones at their default. */
function listHref(filters: ListFilters, page?: number): string {
  const params = new URLSearchParams();
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.q) params.set("q", filters.q);
  // The filter by age is only on "Resolved" with nothing searched.
  if (filters.resolved && filters.status === "resolved" && !filters.q) {
    params.set("resolved", filters.resolved);
  }
  if (filters.sort !== "open_first") {
    params.set("sort", filters.sort.by);
    params.set("direction", filters.sort.direction);
  }
  if (page !== undefined) params.set("page", String(page));
  const query = params.toString();
  return query ? `/tickets?${query}` : "/tickets";
}

// A demo visitor who pressed "Hide" on the welcome card above their ticket list: kept in their
// browser for a year, so it needs no account setting and no script.
const WELCOME_COOKIE = "demo_welcome";
const WELCOME_HIDDEN_FOR = 365 * 24 * 60 * 60 * 1000;

/** The demo's welcome card: where its two quiet links lead, as the demo team member. */
type DemoWelcome = {
  teamId: string;
  /** The ticket an AI assistant worked in the recorded run, or null when there is none. */
  recordedRunHref: string | null;
};

/**
 * The welcome card for a visitor trying the demo as its customer, until they hide it. Nobody
 * else gets it: the team and the admin preview arrived there by choosing to.
 */
function demoWelcome(actor: Actor, hidden: boolean, recordedRunKey: string | null) {
  if (actor.demo !== true || actor.role !== "customer" || hidden) return null;
  const team = DEMO_ACTORS.find((person) => person.role === "team");
  if (team === undefined) return null;
  const welcome: DemoWelcome = {
    teamId: team.id,
    recordedRunHref: recordedRunKey === null ? null : `/tickets/${recordedRunKey}`,
  };
  return welcome;
}

/** The one step a viewer can take now, as the ticket page's primary button. */
type NextStep = {
  label: string;
  /** A form the button submits, or else the place on the page the button leads to. */
  form?: { action: string; fields?: Record<string, string> };
  href?: string;
  /** One short line after the button: only on the demo's sample, which skips the fix. */
  note?: string;
  /** Outlined rather than filled: while an assistant asks for a review, the review comes first. */
  outlined?: boolean;
  /**
   * What would prove it is fixed, said once more right above "Mark fixed and tell the customer":
   * the press is the team's word that it was met. Only when the ticket has one.
   */
  oath?: string;
};

/**
 * The step this viewer can take now: take the ticket and start work, start work, then mark it
 * fixed and tell the customer. Each is possible when it is shown; null when there is nothing for
 * this viewer to press. On the demo's sample, marking it fixed says the sample skips the fix.
 * While an assistant asks for a review, that step is outlined, since the review comes first.
 * Marking it fixed carries what would prove it is fixed, which the press agrees was met.
 */
function nextStep(
  ticket: Ticket,
  allowed: ReturnType<TicketService["allowedActions"]>,
  sample: boolean,
  reviewRequested: boolean,
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
  // One press resolves it as fixed and tells the customer, who can say it is not. Where it is
  // fixed is an optional box on the Status menu's Resolved form. Asking first is under "More
  // options".
  if (allowed.markReady && allowed.resolveWithReason) {
    const step: NextStep = {
      label: "Mark fixed and tell the customer",
      form: { action: `${at}/resolve`, fields: { reason: "fixed_no_reply", from: "next-step" } },
    };
    if (sample) step.note = "The sample skips the fix.";
    if (reviewRequested) step.outlined = true;
    if (ticket.fix_check !== null && ticket.fix_check.trim() !== "") step.oath = ticket.fix_check;
    return step;
  }
  return null;
}

type TicketAction = (key: string, input: unknown, actor: Actor) => Ticket;

/**
 * What a resolve form sends to the rules. A note goes with Fixed, as where it is fixed, with
 * Other, as why, and with Won't fix or Cannot reproduce, as a note for the customer. The Status
 * menu's form has a box for each, so its Fixed box is named fixed_in; the box for the other
 * reasons, hidden and perhaps left with words in it, is not sent with Fixed. A duplicate names
 * its ticket instead, and sends no note.
 */
const NOTE_REASONS = new Set(["other", "wont_fix", "cannot_reproduce"]);
function resolveFields(input: unknown): Record<string, unknown> {
  const fields = { ...(input as Record<string, unknown>) };
  const fixedIn = fields.fixed_in;
  // Which form it came from is for the page, not the rules.
  delete fields.from;
  delete fields.fixed_in;
  if (fields.reason === "fixed_no_reply") {
    if (fixedIn !== undefined) fields.note = fixedIn;
  } else if (!NOTE_REASONS.has(String(fields.reason))) {
    delete fields.note;
  }
  return fields;
}

// What each ticket-page form says it saved. The answer form says one thing or the other, and
// reopening says one thing to the customer and another to the team.
const FORM_SAVED: Record<Problem["form"], (input: unknown, actor: Actor) => SavedKey> = {
  agreedCheck: () => "check",
  changeLink: () => "link",
  ready: () => "ready",
  // The customer's reopening says the same as their No: the ticket is back with the team.
  reopen: (_input, actor) => (actor.role === "customer" ? "notFixed" : "reopenedByTeam"),
  handOff: () => "handedOff",
  resolve: (input) =>
    (input as Record<string, unknown> | undefined)?.reason === "fixed_no_reply"
      ? "markedFixed"
      : "resolvedByTeam",
  markFixed: () => "markedFixed",
  verify: () => "checkChosen",
  answer: (input) =>
    (input as Record<string, unknown> | undefined)?.fixed === "yes" ? "fixed" : "notFixed",
};
const emptyEntry: EntryForm = { kind: "reply", body: "" };

const emptyForm = { title: "", description: "", where_url: "", fix_check: "" };

// What differs between the two uses of the ticket form: its heading, where it posts, its button.
// Both show the description's limit.
const newForm = {
  title: "New ticket",
  // The header leaves out its "New ticket" button on the page it leads to.
  onNewTicketForm: true,
  action: "/tickets",
  submitLabel: "File ticket",
  descriptionLimit: DESCRIPTION_LIMIT,
};

function editForm(key: string) {
  return {
    title: `Edit ${key}`,
    action: `/tickets/${key}/edit`,
    submitLabel: "Save changes",
    descriptionLimit: DESCRIPTION_LIMIT,
  };
}

// The heading of each list, for the page title.
const FILTER_TITLES = { ...STATUS_LABELS, all: "All", open: "Open", archived: "Archived" };

// The reasons on the ticket page's resolve form. Fixed says on the form what it does, that the
// customer is told; the saved outcome keeps the reason's full words.
const RESOLVE_FORM_LABELS = {
  ...RESOLVE_REASON_LABELS,
  fixed_no_reply: "Fixed (the customer is told)",
};

// The reasons the list's bar offers for resolving many tickets at once: the two that need no
// more words, so the bar never holds a text box. A duplicate or an odd case is one ticket's
// judgement, made on its own page. Fixed is too: marking a ticket fixed agrees that what would
// prove it is fixed was met, which is said ticket by ticket. The rules and the JSON API keep all
// five.
const BULK_RESOLVE_REASONS = {
  wont_fix: RESOLVE_REASON_LABELS.wont_fix,
  cannot_reproduce: RESOLVE_REASON_LABELS.cannot_reproduce,
};

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
  ["fix_check", "What would prove it is fixed?"],
  ["where_url", "Page where it happened"],
];

/** The four boxes of the edit form, filled in with the ticket as it is now. */
function ticketValues(ticket: Ticket): typeof emptyForm {
  return {
    title: ticket.title,
    description: ticket.description,
    where_url: ticket.where_url ?? "",
    fix_check: ticket.fix_check ?? "",
  };
}

/** A fingerprint of each of the four boxes, as the ticket holds them now. */
function ticketFingerprints(ticket: Ticket): typeof emptyForm {
  return {
    title: fingerprint(ticket.title),
    description: fingerprint(ticket.description),
    where_url: fingerprint(ticket.where_url),
    fix_check: fingerprint(ticket.fix_check),
  };
}

/**
 * What the edit form held when it was opened, as the fingerprints in its hidden "loaded_" boxes,
 * or null when it has none. These come from the browser, so they only word the message after a
 * refused save: the save itself is checked against the ticket's version, never against these.
 */
function readLoaded(body: Record<string, unknown> | undefined): typeof emptyForm | null {
  const sent = BOX_NAMES.some(([field]) => typeof body?.[`loaded_${field}`] === "string");
  if (!sent) return null;
  return {
    title: asText(body?.loaded_title),
    description: asText(body?.loaded_description),
    where_url: asText(body?.loaded_where_url),
    fix_check: asText(body?.loaded_fix_check),
  };
}

/**
 * The boxes someone else changed since the form was opened, each with the text it holds now, so
 * the person need not compare the ticket and their draft box by box.
 */
function changedSinceLoaded(ticket: Ticket, loaded: typeof emptyForm) {
  return BOX_NAMES.filter(([field]) => fingerprint(ticket[field]) !== loaded[field]).map(
    ([field, name]) => ({ name, now: (ticket[field] ?? "").trim() }),
  );
}

/**
 * The names of the boxes whose text differs from the ticket as it is now. They are compared the
 * way a ticket stores them: trimmed, and with a browser's CR LF line breaks the same as plain ones.
 */
function differingBoxes(ticket: Ticket, values: typeof emptyForm): string[] {
  return BOX_NAMES.filter(
    ([field]) => !sameText((ticket[field] ?? "").trim(), values[field].trim()),
  ).map(([, name]) => name);
}

/** How many email notices of a ticket this viewer may see, by the ticket's key. */
export type NoticeCounter = (key: string, actor: Actor) => number;

/**
 * The small form to show from the page's address: resolve or reopen, which the Status menu asks
 * for in the next step's place, or verify, the customer's step after filing, in the check's place.
 */
const stepQuery = z.enum(["resolve", "reopen", "verify"]);

/** The address of one picture: its ticket's key and its own id. */
type PictureParams = { key: string; id: string };

/** True when the form that came in carried at least one chosen picture. */
function picturesSent(res: Response): boolean {
  return picturesOf(res).files.some((bytes) => bytes.length > 0);
}

/** The line the ticket list shows after a batch of sample tickets, by how many were added. */
const SAMPLES_ADDED = new Map<number, SavedKey>([
  [10, "samplesAdded10"],
  [25, "samplesAdded25"],
  [50, "samplesAdded50"],
]);

/** What the pages need to know about this server. */
export type PageOptions = {
  /** True in production, where cookies are sent over https only. */
  secureCookies: boolean;
  /** True on the demo, which also offers a batch of made-up tickets on its About page. */
  demo?: boolean;
};

export function pagesRouter(
  service: TicketService,
  countNotices: NoticeCounter,
  options: PageOptions,
): Router {
  const router = Router();

  // A cheap read for a ticket page left open, which asks it now and then to notice a change made
  // elsewhere. It is registered before the middleware below, so asking never uses up the
  // message a page shows once after a save. Reading is not counted against the write limit.
  // The status rides along, so the page can say what kind of change it was; the viewer sees the
  // status on the ticket page anyway.
  router.get("/tickets/:key/version", (req, res) => {
    const actor = signedIn(req);
    const stamp = service.ticketStamp(req.params.key, actor);
    const { status } = service.getTicket(req.params.key, actor);
    res.json({ ...stamp, status });
  });

  // The ways to verify a ticket that an assistant suggested, for a page to ask now and then
  // while the customer waits for them. Only the customer who filed it and the team may read
  // them, as for the ticket. Like /version above, it never uses up the message a page shows
  // once, and reading is not counted against the write limit. Signed-in pages are never kept by
  // a cache, and this answer says so itself too.
  // Beside them: whether an assistant that may answer a request is listening now, whether one
  // takes the requests a page sends by itself, and where this person's own request stands.
  router.get("/tickets/:key/check-suggestions", (req, res) => {
    const actor = signedIn(req);
    const suggestions = service.listCheckSuggestions(req.params.key, actor);
    const { available, request } = service.suggestionRequestState(req.params.key, actor);
    res.set("Cache-Control", "private, no-store");
    res.json({ check_suggestions: suggestions, available, request });
  });

  // The customer who filed a New ticket with no check asks a listening assistant for ways to
  // verify it: by pressing for them, or their page by itself with pressed=false. A page's
  // script asks for JSON and gets the request's state, or the refusal as JSON. A form with
  // scripts off goes back to the ticket, with the reason when it was refused.
  router.post("/tickets/:key/check-suggestions/request", (req, res) => {
    const actor = signedIn(req);
    const wantsJson = req.accepts(["html", "json"]) === "json";
    res.set("Cache-Control", "private, no-store");
    try {
      const answer = service.requestSuggestions(req.params.key, req.body, actor);
      if (wantsJson) {
        res.status(201).json(answer);
        return;
      }
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (wantsJson) {
        const { status, body } = errorBody(err);
        res.status(status).json(body);
        return;
      }
      // A ticket this person may not see is answered as every other page answers it.
      if (err.status === 404 || err.status === 403) throw err;
      rememberProblem(res, err.message);
    }
    res.redirect(303, `/tickets/${encodeURIComponent(req.params.key)}`);
  });

  // One picture on a ticket, for whoever may see what it is attached to. Every refusal is the
  // same 404 as a picture that is not there. The answer is only ever shown as a picture: its
  // stored type, checked from its bytes when it was added, no file name from the upload, and a
  // policy that lets the response itself run nothing. Like /version above, it comes before the
  // middleware below, so loading a picture never uses up the message a page shows once. Only a
  // few pictures are sent at once, each within a deadline, since each is held in memory.
  const countPictureSends = sendPicturesFewAtOnce();
  router.get(
    "/tickets/:key/pictures/:id",
    countPictureSends,
    (req: Request<PictureParams>, res) => {
      const actor = signedIn(req);
      const id = /^[1-9][0-9]{0,14}$/.test(req.params.id) ? Number(req.params.id) : 0;
      const picture = service.readPicture(req.params.key, id, actor, viewerToken(req));
      res.set({
        "Content-Type": picture.type,
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        // Kept by this browser only. The demo decides by a cookie who sees a picture.
        "Cache-Control": "private, max-age=3600",
        Vary: "Cookie",
      });
      res.send(picture.bytes);
    },
  );

  // A page opened just after a save says what was saved.
  router.use((req, res, next) => {
    // Both forms that take pictures say how many and how large.
    res.locals.pictureLimits = service.pictureLimits;
    if (req.method === "GET") {
      res.locals.saved = takeSaved(req, res);
      // After a switch of person on the demo: who the visitor is now, by name.
      if (res.locals.saved === SAVED_MESSAGES.switched && req.actor !== null) {
        res.locals.saved = switchedMessage(req.actor);
      }
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
    // The proof step's box after a "+" was pressed with scripts off: the step shows again with
    // these words, and nothing is saved.
    proofWords?: string,
  ): void {
    const actor = signedIn(req);
    const ticket = service.getTicket(req.params.key as string, actor);
    // Just after filing, the receipt names this ticket.
    if (res.locals.saved === SAVED_MESSAGES.filed) res.locals.saved = filedMessage(ticket.key);
    const entries = service.listEntries(ticket.key, actor);
    const pictures = service.listPictures(ticket.key, actor, viewerToken(req));
    // The description's pictures were added by whoever filed the ticket, named in their text.
    const filerName =
      ticket.created_by === null
        ? "Unknown person"
        : (service.peopleNames([ticket.created_by]).get(ticket.created_by) ?? "Unknown person");
    const events = service.listEvents(ticket.key, actor);
    const names = service.peopleNames(events.map((event) => event.actor));
    // A person's role beside their name, as in the conversation, since the name is theirs to set.
    const roles = service.peopleRoles(events.map((event) => event.actor));
    // Marking it fixed agreed that what would prove it is fixed was met, when the ticket says
    // that now and nobody wrote or changed it afterwards: chose a check, adopted one, or edited
    // it in Edit ticket.
    const setsProof = (event: (typeof events)[number]) => {
      if (event.type === "check_chosen" || event.type === "check_adopted") return true;
      if (event.type !== "edited") return false;
      const changes = (event.data as { changes?: Record<string, unknown> }).changes ?? {};
      return changes.fix_check !== undefined;
    };
    const agreedProof = (index: number) =>
      ticket.fix_check !== null && !events.slice(index + 1).some(setsProof);
    // The recorded assistant's rows on the demo happened in a run of their own, on an earlier day.
    const historyWhat = (event: (typeof events)[number], index: number) => {
      const what = describeEvent(event, { agreedProof: agreedProof(index) });
      return event.actor === RECORDED_ASSISTANT.id
        ? `${what}, replayed from the run of Nov 18, 2026`
        : what;
    };
    const history = events.map((event, index) => ({
      when: event.created_at,
      what: historyWhat(event, index),
      who: describeActor(event, names),
      role:
        event.actor_kind === "agent"
          ? null
          : roleAfterName(
              describeActor(event, names),
              roles.get(event.actor) ?? null,
              req.app.locals.demo === true,
            ),
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
    // Everything an assistant left on the ticket, for one card under the description: what it
    // last asked for, its test spec and its evidence, and how a person's decision on the spec
    // ended. A customer sees only a spec the team accepted.
    const staff = actor.role !== "customer";
    const signal = service.assistantSignals([ticket], actor).get(ticket.key) ?? null;
    const lastSpecEvent = events.filter((event) => event.type.startsWith("spec_")).at(-1);
    const discardedBy =
      staff && !specPanel.spec && lastSpecEvent?.type === "spec_discarded"
        ? describeActor(lastSpecEvent, names)
        : null;
    // A person on the team can propose a spec too. The card then names them, and still does
    // after someone discards it.
    const lastProposal = events.filter((event) => event.type === "spec_proposed").at(-1);
    const proposedBy =
      specPanel.spec?.proposed_by.kind === "person"
        ? specPanel.spec.proposed_by.name
        : discardedBy !== null && lastProposal?.actor_kind === "person"
          ? describeActor(lastProposal, names)
          : null;
    const agentEvidence = evidence.some((item) => item.reported_by.kind === "agent");
    // A request for review is said on the ticket's card above, so only a blocked assistant
    // counts here.
    const blocked = signal?.label === "Assistant blocked:" ? signal.text : null;
    const showCard = staff
      ? blocked !== null || specPanel.spec !== null || agentEvidence || discardedBy !== null
      : specPanel.spec !== null;
    // What the assistant last reported, as one grey line above the next step, so the team
    // reads it before resolving: the latest piece's result, or its summary when it has none.
    // Only for the team, and only until the ticket is resolved.
    const latestFromAssistant = evidence.filter((item) => item.reported_by.kind === "agent").at(-1);
    const reported =
      staff && ticket.status !== "resolved" && latestFromAssistant !== undefined
        ? (latestFromAssistant.result ?? latestFromAssistant.summary).split("\n")[0]!.trim()
        : null;
    const assistantCard = showCard
      ? {
          key: ticket.key,
          from: proposedBy === null ? "From the AI assistant" : `From ${proposedBy}`,
          blocked,
          spec: specPanel.spec,
          discardedBy,
          canDecide: specPanel.canDecide,
          reported,
          // The reported line links here, and the evidence then shows unfolded.
          evidenceOpen: req.query.evidence === "open",
          evidence: staff ? evidence : [],
          // On the demo's recorded run, for the team: when it was recorded, and the key the
          // sample had then, only when it differs from this ticket's key.
          recorded: staff && service.recordedRunKey() === ticket.key,
          recordedAs:
            staff && service.recordedRunKey() === ticket.key && ticket.key !== RECORDED_SAMPLE_KEY
              ? RECORDED_SAMPLE_KEY
              : null,
        }
      : null;
    // The card at the top of the main column: the customer's check, the one line saying where the
    // ticket stands, and the one step. The line about a No or a reopening links to the customer's
    // own message, which their answer wrote into the conversation at the same moment.
    const reviewBy = signal?.label === "Review requested by" ? signal.text : null;
    const notFixed = notFixedCard(ticket, events);
    const confirmed = confirmedAt(ticket, events);
    // While the assistant's card shows an open suggestion, it is the request itself, so the line
    // does not say it again, for any viewer, the read-only admin included.
    const reviewOnCard = assistantCard !== null && assistantCard.spec?.state === "proposed";
    const line = cardLine(ticket, actor.role, {
      confirmed,
      notFixed,
      reviewBy: reviewOnCard ? null : reviewBy,
    });
    // The ask is outlined only while the card's line is the request for review. The customer's
    // No comes first on that line, and then the ask is the thing to do.
    const message =
      line?.messageAt == null
        ? undefined
        : entries.find(
            (item) => item.author_role === "customer" && item.created_at === line.messageAt,
          );
    // A ticket resolved as a duplicate links to the other ticket for anyone who may open it:
    // the team, or a customer who filed that one too. Otherwise the line names it only.
    const duplicateOf = ticket.resolution?.duplicate_of ?? null;
    const card = {
      line,
      lineHref: message === undefined ? null : `#entry-${message.id}`,
      otherHref:
        duplicateOf !== null && service.visibleKey(duplicateOf, actor) !== null
          ? `/tickets/${duplicateOf}`
          : null,
      // Just after asking, the card says so once, in place of its line.
      asked: res.locals.saved === SAVED_MESSAGES.ready ? SAVED_MESSAGES.ready : null,
    };
    if (card.asked !== null) res.locals.saved = null;
    // Resolved, Reopen or the customer's step after filing asks for its form in the address.
    const step = stepQuery.safeParse(req.query.step);
    // What would prove it is fixed. Its filer sets or changes it in a small step of its own,
    // until the ticket is resolved or the team asks them; nobody else can.
    const canProve =
      ticket.archived_at === null &&
      ticket.status !== "resolved" &&
      !allowed.answer &&
      can(actor, "choose_check", ticket);
    const proofStep =
      canProve &&
      (problem?.form === "verify" ||
        proofWords !== undefined ||
        (req.method === "GET" && step.success && step.data === "verify"));
    const sample = isWalkthroughSample(ticket, actor);
    const offered = service
      .listCheckSuggestions(ticket.key, actor)
      .filter((suggestion) => suggestion.state === "offered");
    const boxWords =
      proofWords ??
      (problem?.form === "verify"
        ? (problem.values?.words ?? "")
        : (ticket.fix_check ?? (sample ? SAMPLE_PROOFS[0] : "")));
    const proof = {
      step: proofStep,
      words: boxWords,
      // The suggestions, each a "+" that adds its words to the box. "Change" beside a saved
      // check opens the same box with them, when there are some.
      choices: proofStep ? proofChoices(sample, offered, boxWords) : [],
      sample,
      // A page may ask a listening assistant only on a New ticket with no check, off the demo.
      canAsk:
        proofStep && actor.demo !== true && ticket.status === "new" && ticket.fix_check === null,
      // The filer's quiet links, "Change" beside the check or "Add what would prove it".
      canChange: canProve && !proofStep,
      // The team's one grey line while suggestions wait for the customer.
      waiting: staff && ticket.fix_check === null ? waitingLine(offered.length) : null,
      // Just after saving, the card says so once, under the check.
      saved: res.locals.saved === SAVED_MESSAGES.checkChosen ? SAVED_MESSAGES.checkChosen : null,
    };
    if (proof.saved !== null) res.locals.saved = null;
    res.status(status).render("ticket-show", {
      ...helpers,
      title: `${ticket.key}: ${ticket.title}`,
      ticket,
      viewerRole: actor.role,
      viewerId: actor.id,
      assistantCard,
      card,
      demoNext: demoNext(ticket, actor),
      nextStep: nextStep(
        ticket,
        allowed,
        isWalkthroughSample(ticket, actor),
        reviewBy !== null && notFixed === null,
      ),
      statusRow: statusControl(ticket, allowed, actor),
      // The customer's line under the title: where it stands and whose turn it is.
      standing: customerStanding(ticket, confirmed),
      // That form shows in the next step's place.
      step: req.method === "GET" && step.success ? step.data : null,
      proof,
      noticeCount: countNotices(ticket.key, actor),
      assistantSampleKey: service.assistantSampleKey(),
      recordedSampleKey: RECORDED_SAMPLE_KEY,
      handOffTo: service.handOffCandidates(ticket),
      agentHelp,
      // Each message carries its own pictures; the description's are ticketPictures.
      entries: entries.map((item) => ({ ...item, pictures: pictures.byEntry.get(item.id) ?? [] })),
      ticketPictures: pictures.description,
      filerName,
      history,
      evidence,
      allowed,
      possibleDuplicate: possibleDuplicate(ticket, actor),
      resolveReasons: RESOLVE_FORM_LABELS,
      entry: shownEntry,
      problem,
      // What the page's watcher compares with the server's cheap read.
      stamp: service.ticketStamp(ticket.key, actor),
    });
  }

  /**
   * For the team, one older ticket that may report the same problem as this one, or null. The
   * demo's own samples are walked through on their own and share words on purpose: the line
   * never shows on a visitor's sample ticket, the assistant's sample ticket or the recorded
   * assistant run, and never names the last two. A visitor's sample ticket can still be named
   * on a later ticket of theirs that shares its words.
   */
  function possibleDuplicate(ticket: Ticket, actor: Actor): SimilarTicket | null {
    if (isWalkthroughSample(ticket, actor)) return null;
    const samples: string[] = [];
    for (const key of [service.assistantSampleKey(), service.recordedRunKey()]) {
      if (key !== null) samples.push(key);
    }
    if (samples.includes(ticket.key)) return null;
    return service.possibleDuplicate(ticket.key, actor, samples);
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

  /**
   * The list's filters, sort and page, as its address names them, for this viewer. A filter this
   * viewer cannot use, such as Archived for a customer after a role switch or from a bookmark,
   * shows their whole list instead of a refusal. A customer's list is their own tickets, so it
   * has no owner filter to keep.
   */
  function listView(req: Request, actor: Actor): ListView {
    const query = readListPageQuery(req.query);
    const status =
      query.status === "archived" && !can(actor, "list_archived") ? "all" : query.status;
    const owner = actor.role === "customer" ? undefined : query.owner;
    const resolved = query.resolved === "any" ? undefined : query.resolved;
    return { status, owner, q: query.q, sort: query.sort, page: query.page, resolved };
  }

  /**
   * How many tickets this view of the list holds across all its pages. Under "Resolved" with
   * its filter by age, only the resolved tickets of that age count.
   */
  function listTotal(view: ListView, actor: Actor): number {
    const { status, owner, q } = view;
    const cutoff = recentResolvedCutoff(status, q, new Date());
    if (cutoff === undefined || view.resolved === undefined) {
      return service.countListed(status, actor, { owner, q });
    }
    const older = service.countResolvedBefore(actor, { owner, q }, cutoff);
    if (view.resolved === "older") return older;
    return service.countTickets(actor, { owner, q }).resolved - older;
  }

  router.get("/tickets", (req, res) => {
    const actor = signedIn(req);
    const view = listView(req, actor);
    const { q } = view;
    // A ticket key typed into the search, such as "sup-3", opens that ticket when this viewer
    // may see it. Any other text, another customer's key included, is an ordinary search.
    const typedKey = q === undefined ? null : service.visibleKey(q, actor);
    if (typedKey !== null) {
      res.redirect(`/tickets/${typedKey}`);
      return;
    }
    // A page past the end, from an old link or after a change emptied the last page, goes to
    // the last page with the same filters. It comes before the line about a change to many
    // tickets is read, so the page the browser lands on still says it.
    const last = lastPage(listTotal(view, actor));
    if (view.page > last) {
      res.redirect(listHref(view, last > 1 ? last : undefined));
      return;
    }
    // Just after a change to many tickets, the list says what it did.
    const names = (id: string) => service.peopleNames([id]).get(id);
    const outcome = takeBulkOutcome(req, res, names);
    if (outcome !== null) res.locals.saved = outcome;
    showList(req, res, 200, emptyBulkForm);
  });

  /**
   * Changes many tickets at once from the list: the ticked ones, to one status or one owner.
   * The form's address carries the list's own, so the browser goes back to the same view, which
   * says what changed. A refused form shows the list again with the boxes still ticked.
   */
  router.post("/tickets/bulk", (req, res) => {
    const actor = signedIn(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // The bar has one Apply. It sends whichever of the status and the owner was chosen, and
    // both when both were: each as its own change by the same rules, the status first. With
    // neither chosen, the status change is sent alone, and its rules ask for a choice.
    // The page shows the note box only for Other, so a note left there for another reason is
    // not sent, as on the ticket page.
    const chosen = (value: unknown) => typeof value === "string" && value.trim() !== "";
    const statusInput = {
      keys: body.keys,
      status: body.status,
      reason: body.reason,
      duplicate_of: body.duplicate_of,
      ...(body.reason === "other" ? { note: body.note } : {}),
    };
    const ownerInput = { keys: body.keys, owner: body.owner };
    const inputs = [
      ...(chosen(body.status) || !chosen(body.owner) ? [statusInput] : []),
      ...(chosen(body.owner) ? [ownerInput] : []),
    ];
    try {
      // Both changes are checked before either is made, so a refused owner never leaves the
      // status changed behind a page that says the form was refused.
      for (const input of inputs) service.checkChange(input, actor);
      const outcomes = inputs.map((input) => service.changeTickets(input, actor));
      rememberBulkOutcome(res, outcomes);
      const view = listView(req, actor);
      res.redirect(303, listHref(view, view.page > 1 ? view.page : undefined));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const ticked = [body.keys].flat().filter((key): key is string => typeof key === "string");
      const values: Record<string, string> = {};
      for (const name of ["status", "reason", "note", "duplicate_of", "owner"]) {
        if (typeof body[name] === "string") values[name] = body[name];
      }
      const message = Object.values(err.fieldErrors).flat()[0] ?? err.message;
      showList(req, res, 400, { ticked: new Set(ticked), values, message });
    }
  });

  /** Renders the ticket list, with the bar for changing ticked tickets when the viewer may. */
  function showList(req: Request, res: Response, status: number, bulkForm: BulkForm): void {
    const actor = signedIn(req);
    const view = listView(req, actor);
    const current = view.status;
    const { owner, q, sort } = view;
    const pageNumber = view.page;
    // "Resolved" shows every resolved ticket, or with its filter by age, only the ones resolved
    // in the last 14 days or only the ones before that. Every other link and a search show every
    // age.
    const cutoff = recentResolvedCutoff(current, q, new Date());
    const age: ResolvedAge = cutoff === undefined ? "any" : (view.resolved ?? "any");
    const tickets = service.listTickets(
      current,
      actor,
      pageNumber,
      { owner, q },
      sort,
      age === "recent" ? cutoff : undefined,
      age === "older" ? cutoff : undefined,
    );
    const olderResolved =
      cutoff === undefined ? 0 : service.countResolvedBefore(actor, { owner, q }, cutoff);
    // Beside each status filter: how many tickets it holds with the same owner filter and search.
    const counts = service.countTickets(actor, { owner, q });
    // Every link on the list keeps the other filters, so a filtered view can be shared.
    const filters: ListFilters = { status: current, owner, q, sort, resolved: view.resolved };
    const signals = service.assistantSignals(tickets, actor);
    const reopened =
      actor.role === "customer" ? new Set<string>() : service.reopenedByCustomer(tickets);
    // The team ticks tickets and changes them together. The read-only preview, customers and
    // assistants do not.
    // Its form posts to the list's own address with "/bulk" added, so it comes back to this view.
    const thisView = listHref(filters, pageNumber > 1 ? pageNumber : undefined);
    const bulk = can(actor, "bulk_change")
      ? {
          ...bulkForm,
          action: thisView.replace("/tickets", "/tickets/bulk"),
          members: service.teamMembers().filter((member) => member.id !== actor.id),
          resolveReasons: BULK_RESOLVE_REASONS,
        }
      : null;
    res.status(status).render("ticket-list", {
      ...helpers,
      bulk,
      title:
        current !== "all"
          ? `${FILTER_TITLES[current]} tickets`
          : actor.role === "customer"
            ? "My tickets"
            : "All tickets",
      current,
      tickets: tickets.map((ticket) => {
        const tag = turnTag(ticket, actor.role, {
          reopened: reopened.has(ticket.key),
          signal: signals.get(ticket.key),
        });
        // The customer's question leads straight to where they answer it on the ticket.
        const tagHref =
          actor.role === "customer" && tag === CUSTOMER_ANSWER_TAG
            ? `/tickets/${ticket.key}#did-this-fix-it`
            : null;
        return { ...ticket, tag, tagHref };
      }),
      viewerRole: actor.role,
      // Under a list of more than one page: the page before, where this one sits, the page after.
      pages: listPages(pageNumber, listTotal(view, actor), (page) =>
        listHref(filters, page > 1 ? page : undefined),
      ),
      filters,
      href: (change: Partial<ListFilters>) => listHref({ ...filters, ...change }),
      // Who owns a ticket is the team's question; a customer's list is their own tickets.
      ownerFilters: actor.role !== "customer",
      narrowed: owner !== undefined || q !== undefined,
      noMatch: noMatchWords(current, owner, q, age),
      counts,
      // On "Resolved" with nothing searched: which resolved tickets it shows by age. It shows
      // whenever there is a resolved ticket.
      ageFilter: cutoff !== undefined && counts.resolved > 0 ? { olderCount: olderResolved } : null,
      age,
      // Each header that sorts, with the address a press opens. A new sort starts on page one.
      sortHeaders: sortHeaders(sort).map((header) => ({
        ...header,
        href: listHref({ ...filters, sort: header.next }),
      })),
      // Nobody archives on the demo, so its Archived tab would always be empty. The address
      // still works there, and says why it is empty.
      showArchivedFilter: can(actor, "list_archived") && actor.demo !== true,
      // One quiet line under the team's tickets: Proofdesk works with their own AI assistant.
      invite: actor.role !== "customer",
      welcome: demoWelcome(
        actor,
        req.cookies?.[WELCOME_COOKIE] === "hidden",
        service.recordedRunKey(),
      ),
    });
  }

  // "Hide" on the demo's welcome card hides it in this browser for good.
  router.post("/welcome/hide", (req, res) => {
    signedIn(req);
    res.cookie(WELCOME_COOKIE, "hidden", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: WELCOME_HIDDEN_FOR,
      path: "/",
    });
    res.redirect(303, "/tickets");
  });

  // On the demo only, "Add sample tickets" on About this demo files a batch of made-up tickets,
  // then opens the ticket list, which says how many were added, or that the demo is full.
  if (options.demo === true) {
    router.post("/demo/samples", (req, res) => {
      const actor = signedIn(req);
      try {
        const added = service.addSampleBatch(req.body, actor, randomInt(2 ** 31));
        rememberSaved(res, SAMPLES_ADDED.get(added)!);
      } catch (err) {
        if (!(err instanceof HttpError && err.code === "budget_full")) throw err;
        rememberSaved(res, "samplesFull");
      }
      res.redirect(303, "/tickets");
    });
  }

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
      let token: string | null = null;
      // The service checks the rules. A browser sends an empty box as "", and for the
      // optional link that means "not given".
      const fileTicket = () => {
        filedNow = true;
        const upload = picturesOf(res);
        token = uploaderToken(req, actor, upload);
        return service.createTicketWithPictures(
          { ...values, where_url: values.where_url === "" ? undefined : values.where_url },
          upload,
          actor,
          token,
        );
      };
      // A form with an id files once. Sent again, it gets back the ticket it already filed.
      const ticket = formId === null ? fileTicket() : fileOnce(service, actor, formId, fileTicket);
      if (filedNow) {
        keepUploaderToken(req, res, token, options.secureCookies);
        // 303 makes the browser fetch the ticket page with GET, so a refresh cannot file it twice.
        rememberSaved(res, "filed");
        // Filing is the first part. A ticket that does not say what would prove it is fixed
        // opens on the second part, the step that asks for it.
        const next = ticket.fix_check === null ? "?step=verify" : "";
        res.redirect(303, `/tickets/${ticket.key}${next}`);
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
      // Show the form again with what was typed and one message under each wrong box. The
      // browser has dropped any chosen pictures, so the line by the picture control says so.
      res.status(400).render("ticket-form", {
        ...newForm,
        formId,
        values,
        errors: withHowFarOver(err.fieldErrors, values.description),
        pictureLine: ticketFormPictureLine(err.fieldErrors.pictures?.join(" "), picturesSent(res)),
      });
    }
  });

  router.get("/tickets/:key", (req, res) => {
    // A key typed in lower case, such as /tickets/sup-3, opens the ticket at its own address
    // when this viewer may see it, as the list's search does.
    const typedKey = service.visibleKey(req.params.key, signedIn(req));
    if (typedKey !== null && typedKey !== req.params.key) {
      res.redirect(`/tickets/${typedKey}`);
      return;
    }
    // Just after a message was sent, the line saying so sits by the message box, where the
    // browser lands. The box starts again on a reply to the customer, as on every page load,
    // so a message meant for the customer never goes to the team only because the last one did.
    const sent =
      res.locals.saved === SAVED_MESSAGES.note || res.locals.saved === SAVED_MESSAGES.reply;
    if (sent) {
      res.locals.sent = res.locals.saved;
      res.locals.saved = null;
    }
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
      // Pictures sent with the message are saved with it, or the message is not saved either.
      const upload = picturesOf(res);
      const token = uploaderToken(req, actor, upload);
      const added = service.addEntryWithPictures(
        req.params.key,
        basedOn === "" ? entry : { ...entry, based_on: basedOn },
        upload,
        actor,
        token,
      );
      keepUploaderToken(req, res, token, options.secureCookies);
      rememberSaved(res, added.kind === "note" ? "note" : "reply");
      // The line that says it was sent is drawn by the message box, with this id.
      res.redirect(303, `/tickets/${ticket.key}#sent`);
    } catch (err) {
      // A message this person may not send, such as one sent after the browser's person changed
      // in another tab, is refused like a mistake in the box: the ticket again, with what was
      // typed kept and the reason under it. Nothing is saved. The read-only preview's form is
      // never read, so it has no text to keep and goes back to the ticket with the reason.
      let status: number;
      let message: string;
      let pictureError: string | undefined;
      if (err instanceof ValidationError) {
        status = 400;
        message = err.fieldErrors.body?.join(" ") ?? err.message;
        pictureError = err.fieldErrors.pictures?.join(" ");
      } else if (err instanceof HttpError && err.status === 403 && entry.body.trim() !== "") {
        status = 403;
        message = err.message;
        // An internal note from someone who cannot write notes now, as after the browser's person
        // changed in another tab. The box shown next sends a message, so say who is signed in.
        if (entry.kind === "note" && !can(actor, "note")) {
          message =
            `Nothing was sent. You are now signed in as ${actor.name}, who cannot write ` +
            "internal notes, so sending this again would send it as a message.";
        }
      } else {
        throw err;
      }
      // Show the ticket again with what was typed and the message under the box. The browser
      // has dropped any chosen pictures, so the message says to choose them again.
      showTicket(req, res, status, {
        ...entry,
        error: messageRefusalLine(message, pictureError, picturesSent(res), entry.body),
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
    const values = ticketValues(ticket);
    res.render("ticket-form", {
      ...editForm(ticket.key),
      values,
      // What the form was opened with, so a refused save can say what someone else changed.
      loaded: ticketFingerprints(ticket),
      errors: {},
      version: ticket.version,
    });
  });

  router.post("/tickets/:key/edit", (req, res) => {
    const actor = signedIn(req);
    // The edit form has no box for what would prove it is fixed: its filer changes that in its
    // own step on the ticket. A form that sends no such box keeps the check as it is.
    const before = service.getTicket(req.params.key, actor);
    const read = readTicketForm(req.body);
    const values =
      typeof req.body?.fix_check === "string"
        ? read
        : { ...read, fix_check: before.fix_check ?? "" };
    const loaded = readLoaded(req.body);
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
      // What the person typed stays.
      const shown = values;
      const errors =
        err instanceof ValidationError ? withHowFarOver(err.fieldErrors, values.description) : {};
      res.status(changed ? 409 : 400).render("ticket-form", {
        ...editForm(current.key),
        values: shown,
        errors,
        // What someone else changed since the form was opened, with the text it holds now. A
        // form sent without what it was opened with names the boxes that differ instead.
        changedByOthers: changed && loaded !== null ? changedSinceLoaded(current, loaded) : null,
        differ: changed && loaded === null ? differingBoxes(current, shown) : [],
        // After a refusal for a newer version the form is now based on the ticket as it is;
        // after a mistake in a box it is still based on what it was opened with.
        loaded: changed ? ticketFingerprints(current) : loaded,
        // The hidden version has no box of its own, so a problem with it is said at the top.
        versionUnreadable: errors.expected_version !== undefined,
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
      throw forbidden(actor, "archive");
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
      throw forbidden(actor, "delete");
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
  // The customer's Yes to a ticket the team marked fixed. It has no boxes to keep.
  router.post("/tickets/:key/confirm", (req, res) => {
    const ticket = service.confirmFix(req.params.key, req.body, signedIn(req));
    rememberSaved(res, "fixed");
    res.redirect(303, `/tickets/${ticket.key}`);
  });
  // Resolving with a reason. Two forms post here: the Status menu's Resolved form, and the next
  // step "Mark fixed and tell the customer", which sends from=next-step so that a refusal is
  // shown beside its own button.
  const resolve: TicketAction = (key, input, actor) =>
    service.resolveWithReason(key, resolveFields(input), actor);
  const resolveFromMenu = ticketForm("resolve", resolve);
  const markFixed = ticketForm("markFixed", resolve);
  router.post("/tickets/:key/resolve", (req, res, next) => {
    if (req.body?.from === "next-step") return markFixed(req, res, next);
    return resolveFromMenu(req, res, next);
  });
  router.post("/tickets/:key/adopt-check", (req, res) => {
    const ticket = service.adoptCheck(req.params.key, signedIn(req), req.body);
    rememberSaved(res, "adopted");
    res.redirect(303, `/tickets/${ticket.key}`);
  });
  // The customer says how they will know it is fixed: the words in the box, which may hold
  // suggested ways added with their "+" buttons. A refusal goes back to the ticket with the reason, as every other refusal does.
  router.post("/tickets/:key/check", (req, res) => {
    const actor = signedIn(req);
    const words = asText(req.body?.words);
    try {
      // A "+" pressed with scripts off adds its words to the box and shows the step again.
      // Nothing is saved until Save.
      const add = asText(req.body?.add);
      if (add.trim() !== "") {
        showTicket(req, res, 200, emptyEntry, null, addToBox(words, add));
        return;
      }
      // The box is what is saved. The suggestion it started from is the first one shown whose
      // words are still in the box, and none when no suggestion's words are there.
      const offered = service.listCheckSuggestions(req.params.key, actor);
      const sent = { ...req.body, suggestion_id: firstInBox(offered, words)?.id };
      const ticket = service.chooseCheck(req.params.key, sent, actor);
      rememberSaved(res, "checkChosen");
      res.redirect(303, `/tickets/${ticket.key}`);
    } catch (err) {
      // What was sent, so the step can show it again.
      const kept = { words };
      const sentSomething = words.trim() !== "";
      // The ticket changed while the box was being filled, for example when the team took it:
      // the step shows again on the ticket as it is now, with what was sent kept.
      if (err instanceof HttpError && err.code === "ticket_changed" && sentSomething) {
        res.locals.refused = onTicketPage(err);
        showTicket(req, res, 409, emptyEntry, {
          form: "verify",
          message: "What you wrote is kept here. Look at the ticket as it is now, then save again.",
          comment: "",
          values: kept,
          focus: "words",
        });
        return;
      }
      if (!(err instanceof HttpError)) throw err;
      if (!(err instanceof ValidationError) && err.code !== "suggestion_gone") throw err;
      // A mistake in the step, such as an empty box: the step shows again with the reason under
      // the box and what was sent kept.
      const message =
        err instanceof ValidationError
          ? (Object.values(err.fieldErrors).flat()[0] ?? err.message)
          : err.message;
      showTicket(req, res, err.status, emptyEntry, {
        form: "verify",
        message,
        comment: "",
        values: kept,
        focus: "words",
      });
    }
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
