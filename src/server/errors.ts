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

type ShownError = { status: number; code: string; message: string };

/**
 * Decides what to tell the caller about anything that was thrown. An unexpected error is
 * logged here and its details are never sent out.
 */
function describeError(err: unknown): ShownError {
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
  const shown = describeError(err);
  res.status(shown.status).json({ error: { code: shown.code, message: shown.message } });
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
