import type { ErrorRequestHandler, RequestHandler } from "express";

/** An error that carries an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * A 400 for input that breaks the rules. Besides the one-line message it carries the
 * messages per field, for example { title: ["..."] }, so a form can show each one in place.
 */
export class ValidationError extends HttpError {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string[] | undefined>,
  ) {
    super(400, "validation_error", message);
    this.name = "ValidationError";
  }
}

type ShownError = {
  status: number;
  code: string;
  message: string;
  fields?: Record<string, string[]>;
};

// What to do next, for each error code a caller can meet. A code not listed falls back to a
// hint for its status.
const HINTS: Record<string, string> = {
  validation_error: "Fix the fields named in `fields` and send again.",
  invalid_key: "Ticket keys look like SUP-42. Check the key and send again.",
  not_signed_in: "Sign in first. A program sends a connection key: Authorization: Bearer <key>.",
  invalid_connection_key:
    "The key is wrong, revoked or expired. Keys are shown once: ask an admin to revoke this connection and issue a new one.",
  cross_site_request:
    "Send the request from a page on this site. A program signs in with a connection key instead.",
  forbidden: "Your role may not do this. GET /api lists who may call each action.",
  not_found: "Check the address. GET /api lists every action.",
  ticket_not_found: "Check the key. GET /api/tickets lists the tickets you may see.",
  ticket_deleted: "This ticket was deleted permanently. Its number is never used again.",
  ticket_archived: "Restore the ticket first, if your role may (POST .../restore).",
  needs_owner: "Take the ticket first (POST .../take), then change the status.",
  needs_customer: "Only the customer's answer resolves a ticket. Ask them with POST .../ready.",
  needs_change_link: "Link the change first (PUT .../change-link), then ask the customer.",
  not_in_progress: "Move the ticket to in_progress first.",
  not_waiting: "The team has not asked this question yet, or it was withdrawn.",
  question_changed: "Get the ticket again and answer with its current ready_token.",
  idempotency_key_reused:
    "Use a new idempotency key for a new request. Reuse a key only to retry the very same request.",
  budget_full: "The demo has no room for more of these. Nothing to retry.",
  too_many_requests: "Wait for the time in the Retry-After header, then send again.",
  bad_request: "The request could not be read. Send JSON with Content-Type: application/json.",
  internal_error: "Something failed on the server. Try again later.",
};

/** Whether sending the same request again can work: only after waiting, or after a failure. */
function canRetry(shown: ShownError): boolean {
  return shown.status === 429 || shown.status >= 500;
}

/** The JSON body of an error: what happened, what to do next, and whether to retry. */
export function errorBody(err: unknown) {
  const shown = describeError(err);
  return {
    status: shown.status,
    body: {
      error: {
        code: shown.code,
        message: shown.message,
        hint:
          HINTS[shown.code] ?? (shown.status >= 500 ? HINTS.internal_error! : HINTS.bad_request!),
        retry: canRetry(shown),
        ...(shown.fields ? { fields: shown.fields } : {}),
      },
    },
  };
}

/**
 * Decides what to tell the caller about anything that was thrown. An unexpected error is
 * logged here and its details are never sent out.
 */
function describeError(err: unknown): ShownError {
  if (err instanceof ValidationError) {
    const fields: Record<string, string[]> = {};
    for (const [name, messages] of Object.entries(err.fieldErrors)) {
      if (messages !== undefined) fields[name] = messages;
    }
    return { status: err.status, code: err.code, message: err.message, fields };
  }
  if (err instanceof HttpError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  const status = httpStatusOf(err);
  if (status !== undefined && status >= 400 && status < 500) {
    return { status, code: "bad_request", message: "The request was invalid." };
  }
  console.error(err);
  return { status: 500, code: "internal_error", message: "Internal server error." };
}

/**
 * The HTTP status a library put on an error, if any. Express's body parser puts a number in
 * "status". The sign-in library puts a word there ("BAD_REQUEST") and the number in
 * "statusCode".
 */
function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  if (typeof status === "number") return status;
  if (typeof statusCode === "number") return statusCode;
  return undefined;
}

// The JSON API answers errors as JSON.

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, "not_found", `No route for ${req.method} ${req.baseUrl}${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { status, body } = errorBody(err);
  res.status(status).json(body);
};

// Pages answer the same errors as a readable HTML page.

export const pageNotFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, "not_found", "There is no page at this address."));
};

export const pageErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const shown = describeError(err);
  if (shown.status === 401) {
    // Nobody is signed in: send the browser to the sign-in page instead of an error. For
    // a page that was being opened, remember its address so sign-in can return to it.
    const next = req.method === "GET" ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
    res.redirect(303, `/sign-in${next}`);
    return;
  }
  let title = "Something went wrong";
  if (shown.status === 404) title = "Not found";
  else if (shown.status < 500) title = "That request did not work";
  res.status(shown.status).render("error", { title, message: shown.message });
};
