import { randomUUID } from "node:crypto";
import compression from "compression";
import type { Request, RequestHandler, Response } from "express";
import morgan from "morgan";

/** Writes one line to standard output. Tests pass their own to read what was written. */
export type LogLine = (line: string) => void;

// An id the host's proxy gave the request is kept, so the same id is in its logs and ours.
// Anything else (missing, too long, odd characters) is replaced by a fresh one, so a caller
// cannot write into the log through it.
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Gives every request an id, the proxy's when it is a safe one, and sends it back. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const given = req.get("fly-request-id") ?? req.get("x-request-id");
    const id = given !== undefined && SAFE_ID.test(given) ? given : randomUUID();
    res.set("X-Request-Id", id);
    next();
  };
}

/** The address without its query string. */
function pathOf(req: Request): string {
  return req.originalUrl.split("?")[0] ?? "/";
}

/**
 * One line of JSON per request, written when the answer ends. The line holds only what is
 * named here: the path without its query string (GitHub's return carries a one-time sign-in
 * code there, and searches carry what a person typed), never headers, cookies or bodies.
 * A health check that passed is not logged, so the host's check every 30 seconds does not
 * bury the rest.
 */
export function requestLog(log: LogLine): RequestHandler {
  return morgan<Request, Response>(
    (tokens, req, res) =>
      JSON.stringify({
        at: new Date().toISOString(),
        request_id: res.getHeader("X-Request-Id") ?? null,
        method: req.method,
        path: pathOf(req),
        status: res.headersSent ? res.statusCode : null,
        ms: Number(tokens["response-time"]?.(req, res) ?? 0),
      }),
    {
      stream: { write: (line: string) => log(line.trimEnd()) },
      skip: (req, res) => pathOf(req) === "/api/health" && res.statusCode < 400,
    },
  );
}

/**
 * Compresses text answers the browser accepts compressed. Two kinds are left alone. Any
 * answer marked no-store, such as the page that shows a new connection key once, because a
 * secret is never compressed beside text a visitor chose. And the MCP endpoint's stream: its
 * library marks it no-transform, which the compression package already honours.
 */
export function compressAnswers(): RequestHandler {
  return compression({
    filter: (req, res) => {
      if (String(res.getHeader("Cache-Control") ?? "").includes("no-store")) return false;
      return compression.filter(req, res);
    },
  });
}
