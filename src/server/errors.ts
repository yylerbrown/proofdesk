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

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, "not_found", `No route for ${req.method} ${req.baseUrl}${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  const status = httpStatusOf(err);
  if (status !== undefined && status >= 400 && status < 500) {
    res
      .status(status)
      .json({ error: { code: "bad_request", message: "The request was invalid." } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: "internal_error", message: "Internal server error." } });
};

function httpStatusOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}
