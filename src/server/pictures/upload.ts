import { randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import type { Actor } from "../actor.js";
import { HttpError } from "../errors.js";
import { PICTURE_REFUSALS, type PictureLimits } from "./limits.js";
import { NO_PICTURES, type PictureUpload } from "./service.js";

// Reading pictures from a form, and the demo visitor's token.
//
// A form that sends pictures is posted as multipart/form-data, with its pictures in a field
// named "pictures". multer reads it, with its limits set in the parser itself, so a picture
// over the size limit is cut off as it arrives instead of being held whole. A plain form, sent
// the usual way, passes straight through to the ordinary form parser's result.
//
// Pictures are held in memory while a request is read, so more rules keep that small: a
// visitor who may add nothing (signed out, or the read-only preview) never has theirs read,
// the whole server reads only two large uploads at a time, one person reads only one of them,
// and each large upload must finish arriving within a deadline. A form no larger than an
// ordinary one is not counted, so a form that declares a length of at most 100 KB is never
// turned away while pictures are being sent.

/** The field a form sends its pictures in. */
export const PICTURES_FIELD = "pictures";

/**
 * The most text fields one form sends, and the largest. The largest matches the ordinary form
 * parser, so a description that is too long still reaches the form's own message about it.
 * No form here sends more than about ten fields.
 */
const MOST_FIELDS = 12;
const LARGEST_FIELD = 100 * 1024;

/**
 * The most large uploads this server reads at once. Each holds up to four pictures in memory,
 * and a finished one waits for the garbage collector, so this stays small.
 */
export const UPLOADS_AT_ONCE = 2;

/**
 * How long a large upload may take to arrive. After that it is cut off and its place freed.
 * A minute lets a phone send four large pictures on a slow connection.
 */
export const UPLOAD_DEADLINE_MS = 60 * 1000;

/**
 * A form whose declared length is at most this is not counted towards UPLOADS_AT_ONCE: it is
 * no larger than the ordinary form parser allows, so it cannot hold much memory.
 */
const ORDINARY_FORM_BYTES = 100 * 1024;

/** True when a form may be larger than an ordinary one, or does not say how large it is. */
function isLarge(req: Request): boolean {
  const declared = Number(req.headers["content-length"]);
  return !(Number.isFinite(declared) && declared <= ORDINARY_FORM_BYTES);
}

export const UPLOAD_REFUSALS = {
  busy: "Many pictures are being sent right now. Wait a minute and send the form again.",
  yoursArriving:
    "Your other pictures are still being sent. Wait for them to finish, then send this form again.",
  unreadable: "That form could not be read. Send it again.",
  notAPictureField: "Only pictures can be sent with this form.",
  tooLarge: "That form is too large to send.",
};

/** The refusal sentence for a limit the parser met, or null when it was not about pictures. */
function refusalFor(err: multer.MulterError, limits: PictureLimits): string | null {
  if (err.code === "LIMIT_FILE_SIZE") return PICTURE_REFUSALS.tooLarge(limits);
  if (err.code === "LIMIT_FILE_COUNT") return PICTURE_REFUSALS.tooManyInMessage(limits);
  // One more picture than the field takes is reported as an unexpected file.
  if (err.code === "LIMIT_UNEXPECTED_FILE" && err.field === PICTURES_FIELD) {
    return PICTURE_REFUSALS.tooManyInMessage(limits);
  }
  return null;
}

/** Who is sending a form, so one person reads only one large upload at a time. */
export type PersonOf = (req: Request) => string;

/** By default a person is their account. app.ts counts demo visitors by address instead. */
const accountOf: PersonOf = (req) => req.actor?.id ?? "";

export type ReadPicturesOptions = {
  personOf?: PersonOf;
  atOnce?: number;
  deadlineMs?: number;
};

/**
 * Refuses a large form without keeping any of it. Its body is still taken in and thrown
 * away, so the sender gets the sentence instead of a dropped connection. A sender that never
 * finishes is cut off at the deadline.
 */
function refuseUnread(
  req: Request,
  next: NextFunction,
  error: HttpError,
  deadlineMs: number,
): void {
  const deadline = setTimeout(() => req.destroy(), deadlineMs);
  let answered = false;
  const answer = () => {
    clearTimeout(deadline);
    if (answered) return;
    answered = true;
    next(error);
  };
  req.once("end", answer);
  req.once("close", answer);
  req.resume();
}

/**
 * Reads a multipart form's text into req.body and its pictures into res.locals.pictures. A
 * picture the limits refuse is not an error here: the route shows the form again with the
 * reason and what was typed, as for any other mistake. Mount it after the actor is known.
 */
export function readPictures(
  limits: PictureLimits,
  options: ReadPicturesOptions = {},
): RequestHandler {
  const personOf = options.personOf ?? accountOf;
  const atOnce = options.atOnce ?? UPLOADS_AT_ONCE;
  const deadlineMs = options.deadlineMs ?? UPLOAD_DEADLINE_MS;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: limits.maxBytes,
      files: limits.perMessage,
      fields: MOST_FIELDS,
      fieldSize: LARGEST_FIELD,
      parts: limits.perMessage + MOST_FIELDS,
    },
  }).array(PICTURES_FIELD, limits.perMessage);
  // The people whose large upload is being read now, across the whole server. Its size is how
  // many are being read.
  const reading = new Set<string>();

  return (req, res, next) => {
    if (!req.is("multipart/form-data")) {
      next();
      return;
    }
    // Nobody signed in, and the read-only preview, may add nothing. Their form is not read at
    // all, and the route answers them as it would any other form.
    if (req.actor === null || req.actor.readOnly === true) {
      next();
      return;
    }
    let deadline: NodeJS.Timeout | undefined;
    if (isLarge(req)) {
      const person = personOf(req);
      // A person's second upload is refused before the count, so it never takes a place.
      if (reading.has(person)) {
        refuseUnread(
          req,
          next,
          new HttpError(429, "pictures_arriving", UPLOAD_REFUSALS.yoursArriving),
          deadlineMs,
        );
        return;
      }
      if (reading.size >= atOnce) {
        refuseUnread(req, next, new HttpError(503, "busy", UPLOAD_REFUSALS.busy), deadlineMs);
        return;
      }
      reading.add(person);
      // An upload that is still arriving at the deadline is cut off. Its connection then
      // closes, which gives its place back.
      deadline = setTimeout(() => req.destroy(), deadlineMs);
      // A response always closes, whether it was sent or the connection dropped.
      res.once("close", () => {
        clearTimeout(deadline);
        reading.delete(person);
      });
    }

    upload(req, res, (err: unknown) => {
      // The form has arrived, or will not: the deadline no longer applies.
      clearTimeout(deadline);
      if (err instanceof multer.MulterError) {
        const refused = refusalFor(err, limits);
        if (refused !== null) {
          res.locals.pictures = { files: [], refused } satisfies PictureUpload;
          next();
          return;
        }
        if (err.code === "LIMIT_UNEXPECTED_FILE") {
          next(new HttpError(400, "not_a_picture_field", UPLOAD_REFUSALS.notAPictureField));
          return;
        }
        next(new HttpError(413, "too_large", UPLOAD_REFUSALS.tooLarge));
        return;
      }
      // Anything else the parser met is a form it could not read: no boundary, or a form cut
      // short because the browser stopped sending it.
      if (err !== undefined) {
        next(new HttpError(400, "unreadable_form", UPLOAD_REFUSALS.unreadable));
        return;
      }
      const files = Array.isArray(req.files) ? req.files : [];
      res.locals.pictures = {
        files: files.map((file) => file.buffer),
        refused: null,
      } satisfies PictureUpload;
      next();
    });
  };
}

/** The pictures the parser read for this request, or none. */
export function picturesOf(res: Response): PictureUpload {
  return (res.locals.pictures as PictureUpload | undefined) ?? NO_PICTURES;
}

// ---- The demo visitor's token ------------------------------------------------------------
// On the shared demo, a visitor's picture is served only to the browser that added it. That
// browser is known by a random token in an http-only cookie, made when it first sends one.

const TOKEN_COOKIE = "demo_pictures";
/** Longer than the demo keeps any data, which resets within two days. */
const TOKEN_LIFETIME = 3 * 24 * 60 * 60 * 1000;
/** 32 random bytes, written in base64url. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** This browser's demo token, or null when it has none. */
export function viewerToken(req: Request): string | null {
  const token: unknown = req.cookies?.[TOKEN_COOKIE];
  return typeof token === "string" && TOKEN_SHAPE.test(token) ? token : null;
}

/**
 * The token to record on pictures this request adds: on the demo, this browser's own, or a
 * new one if it has none; on a real site null, since every picture there follows its ticket.
 * A new token is only made here. keepUploaderToken gives it to the browser once the pictures
 * are saved.
 */
export function uploaderToken(req: Request, actor: Actor, upload: PictureUpload): string | null {
  if (actor.demo !== true || upload.files.length === 0) return null;
  return viewerToken(req) ?? randomBytes(32).toString("base64url");
}

/**
 * Gives this browser the token its saved pictures were recorded with, if it did not hold it
 * already. secure is true in production, so the cookie is sent over https only.
 */
export function keepUploaderToken(
  req: Request,
  res: Response,
  token: string | null,
  secure: boolean,
): void {
  if (token === null || token === viewerToken(req)) return;
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: TOKEN_LIFETIME,
    path: "/",
  });
}
