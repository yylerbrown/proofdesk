import type { RequestHandler } from "express";
import { HttpError } from "../errors.js";

// Sending pictures. A picture is held in memory until its answer has been sent, so the server
// sends only a few at once and gives each answer a deadline. A browser that asks and never
// reads the answer is cut off then, and its place is freed.

/** The most pictures this server sends at once. */
export const SENDS_AT_ONCE = 8;

/**
 * How long one picture's answer may take to be sent. A 2 MB picture needs well under this on
 * a slow phone connection.
 */
export const SEND_DEADLINE_MS = 30 * 1000;

/** How long a browser told the server is busy is asked to wait, in seconds. */
export const SEND_RETRY_SECONDS = 2;

export const SEND_REFUSALS = {
  busy: `Many pictures are being sent right now. Try again in ${SEND_RETRY_SECONDS} seconds.`,
};

export type SendPicturesOptions = {
  atOnce?: number;
  deadlineMs?: number;
};

/**
 * Counts the pictures being sent. Mount it before the route that sends a picture. Above the
 * count the answer is 503 with a Retry-After header; the place is freed when the answer closes.
 */
export function sendPicturesFewAtOnce(options: SendPicturesOptions = {}): RequestHandler {
  const atOnce = options.atOnce ?? SENDS_AT_ONCE;
  const deadlineMs = options.deadlineMs ?? SEND_DEADLINE_MS;
  let sending = 0;

  return function countPictureSends(_req, res, next) {
    if (sending >= atOnce) {
      res.set("Retry-After", String(SEND_RETRY_SECONDS));
      next(new HttpError(503, "busy", SEND_REFUSALS.busy));
      return;
    }
    sending += 1;
    // An answer not yet sent at the deadline is cut off, which closes it.
    const deadline = setTimeout(() => res.destroy(), deadlineMs);
    // An answer always closes, whether it was sent or the connection dropped.
    res.once("close", () => {
      clearTimeout(deadline);
      sending -= 1;
    });
    next();
  };
}
