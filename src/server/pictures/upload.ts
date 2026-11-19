import { randomBytes } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
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
// Pictures are held in memory while a request is read, so two more rules keep that small: a
// visitor who may add nothing (signed out, or the read-only preview) never has theirs read,
// and the whole server reads only a few uploads at a time.

/** The field a form sends its pictures in. */
export const PICTURES_FIELD = "pictures";

/**
 * The most text fields one form sends, and the largest. The largest matches the ordinary form
 * parser, so a description that is too long still reaches the form's own message about it.
 * No form here sends more than about ten fields.
 */
const MOST_FIELDS = 12;
const LARGEST_FIELD = 100 * 1024;

/** The most uploads this server reads at once. Each holds at most a few pictures in memory. */
export const UPLOADS_AT_ONCE = 6;

export const UPLOAD_REFUSALS = {
  busy: "Many pictures are being sent right now. Wait a minute and send the form again.",
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

/**
 * Reads a multipart form's text into req.body and its pictures into res.locals.pictures. A
 * picture the limits refuse is not an error here: the route shows the form again with the
 * reason and what was typed, as for any other mistake. Mount it after the actor is known.
 */
export function readPictures(limits: PictureLimits, atOnce = UPLOADS_AT_ONCE): RequestHandler {
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
  // How many uploads are being read now, across the whole server.
  let reading = 0;

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
    if (reading >= atOnce) {
      next(new HttpError(503, "busy", UPLOAD_REFUSALS.busy));
      return;
    }
    reading += 1;
    // The place is given back once, when the answer is sent or the connection closes.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      reading -= 1;
    };
    res.once("finish", release);
    res.once("close", release);

    upload(req, res, (err: unknown) => {
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
