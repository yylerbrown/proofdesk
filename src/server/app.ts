import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import { toNodeHandler } from "better-auth/node";
import express, { type Express } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { actorMiddleware } from "./actor.js";
import { createAuth } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import {
  errorHandler,
  HttpError,
  notFoundHandler,
  pageErrorHandler,
  pageNotFoundHandler,
} from "./errors.js";
import { healthRouter } from "./routes/health.js";
import { pagesRouter } from "./routes/pages.js";
import { signInRouter } from "./routes/sign-in.js";
import { checkDatabasePurpose } from "./purpose.js";
import { sameOriginOnly } from "./same-origin.js";
import { ticketsRouter } from "./routes/tickets.js";
import { createTicketService } from "./tickets/service.js";

// The top folder of the project. It is two levels above this file, both in src/server (when
// run from source) and in dist/server (when run after a build).
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The largest request body the server reads, for JSON and for forms. A larger one is
// refused with 413 before any of it is looked at. The biggest valid ticket is about 6 KB.
const BODY_LIMIT = "100kb";

// How many tickets one person may file in ten minutes, and how many sign-ins one address
// may start in a minute.
export const FILING_LIMIT = 20;
export const SIGN_IN_LIMIT = 10;

const picoCssFile = path.join(rootDir, "node_modules/@picocss/pico/css/pico.min.css");

/** Builds the Express app without listening, so tests can drive it directly. */
export function createApp(config: Config, db: Db): Express {
  // Refuses a demo server on a real database, and the other way round, before anything else.
  checkDatabasePurpose(db, config.demo);
  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(rootDir, "views"));
  // Every page shows the demo banner when this server is the demo.
  app.locals.demo = config.demo;

  // One ticket service, shared by the JSON API and the pages, so the rules exist once.
  const tickets = createTicketService(db, config.ticketPrefix);

  // Security headers on every answer. The content security policy lets a page load scripts
  // and styles only from this server, so a script written into a page cannot run.
  app.use(
    helmet({
      // Send the address of the page a request comes from only to this server itself.
      // The library's default sends it nowhere, which also makes browsers blank out the
      // Origin header on this site's own forms.
      referrerPolicy: { policy: "same-origin" },
      contentSecurityPolicy: {
        directives: {
          "style-src": ["'self'"],
          // Forms post only to this server. The GitHub sign-in form is answered with a
          // redirect to GitHub, which browsers also count, so GitHub is allowed too.
          "form-action": ["'self'", "https://github.com"],
          // Browsers are told to switch to HTTPS only in production. On a development
          // machine the server speaks plain HTTP and the switch would break the page.
          "upgrade-insecure-requests": config.nodeEnv === "production" ? [] : null,
        },
      },
    }),
  );

  // GitHub sign-in, when its settings are present. The library answers everything under
  // /api/auth itself: the return from GitHub, and its own session routes. It must be
  // mounted before any body parser, because it reads the request body itself.
  const auth = config.signIn === null ? null : createAuth(db, config.signIn, config.clientIpHeader);
  if (auth !== null) {
    app.all("/api/auth/*splat", toNodeHandler(auth));
  }

  app.use(cookieParser());
  // Decides who is acting. It is used twice below, once for the API and once for the
  // pages, so that a failure inside it is answered in the right format for each.
  const actor = actorMiddleware(config, auth, db);

  // Limits on how often one person, or one address when signed out, may file a ticket or
  // start a sign-in. Over the limit the answer is 429 until the window has passed.
  const tooMany: Parameters<typeof rateLimit>[0] = {
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.actor?.id ?? ipKeyGenerator(clientAddress(req)),
    handler: (_req, _res, next) => {
      next(new HttpError(429, "too_many_requests", "Too many requests. Try again in a while."));
    },
  };
  // The visitor's address: from the proxy's header when one is configured, otherwise from
  // the connection.
  function clientAddress(req: express.Request): string {
    const fromProxy =
      config.clientIpHeader === undefined ? undefined : req.get(config.clientIpHeader);
    return fromProxy ?? req.ip ?? "";
  }
  // Refused tickets (a form with a mistake in it) do not count towards the filing limit.
  const filingLimit = rateLimit({
    ...tooMany,
    windowMs: 10 * 60 * 1000,
    limit: FILING_LIMIT,
    skipFailedRequests: true,
  });
  const signInLimit = rateLimit({ ...tooMany, windowMs: 60 * 1000, limit: SIGN_IN_LIMIT });

  // The JSON API. Its own handlers at the end turn every error inside it into JSON.
  const api = express.Router();
  api.use(actor);
  api.use(sameOriginOnly(config));
  api.post("/tickets", filingLimit);
  api.use(express.json({ limit: BODY_LIMIT }));
  api.use(healthRouter(config, db));
  api.use(ticketsRouter(tickets));
  api.use(notFoundHandler);
  api.use(errorHandler);
  app.use("/api", api);

  // The pages: two stylesheets, which need no sign-in and so come before the actor, then
  // the HTML form parser, the routes and the HTML error pages.
  app.get("/assets/pico.min.css", (_req, res) => {
    res.sendFile(picoCssFile);
  });
  app.use("/assets", express.static(path.join(rootDir, "public")));
  app.use(actor);
  app.use(sameOriginOnly(config));
  app.post("/tickets", filingLimit);
  app.post("/sign-in/github", signInLimit);
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  app.use(signInRouter(config, auth));
  app.use(pagesRouter(tickets));
  app.use(pageNotFoundHandler);
  app.use(pageErrorHandler);

  return app;
}
