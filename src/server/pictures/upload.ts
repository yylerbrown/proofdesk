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

/** The field a form sends its pictures in. */
export const PICTURES_FIELD = "pictures";

/** The most text fields one form sends, and the largest, as the ordinary form parser allows. */
const MOST_FIELDS = 50;
const LARGEST_FIELD = 100 * 1024;

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
 * reason and what was typed, as for any other mistake.
 */
export function readPictures(limits: PictureLimits): RequestHandler {
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

  return (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const refused = refusalFor(err, limits);
        if (refused === null) {
          next(new HttpError(413, "too_large", "That form is too large to send."));
          return;
        }
        res.locals.pictures = { files: [], refused } satisfies PictureUpload;
        next();
        return;
      }
      if (err !== undefined) {
        next(err);
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
 * The token to record on pictures this request adds: on the demo, this browser's own, made
 * now if it has none; on a real site null, since every picture there follows its ticket.
 */
export function uploaderToken(
  req: Request,
  res: Response,
  actor: Actor,
  upload: PictureUpload,
): string | null {
  if (actor.demo !== true || upload.files.length === 0) return null;
  const known = viewerToken(req);
  if (known !== null) return known;
  const token = randomBytes(32).toString("base64url");
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: TOKEN_LIFETIME,
    path: "/",
  });
  return token;
}
