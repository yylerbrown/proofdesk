import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import helmet from "helmet";
import { actorMiddleware } from "./actor.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { errorHandler, notFoundHandler, pageErrorHandler, pageNotFoundHandler } from "./errors.js";
import { healthRouter } from "./routes/health.js";
import { pagesRouter } from "./routes/pages.js";
import { signInRouter } from "./routes/sign-in.js";
import { ticketsRouter } from "./routes/tickets.js";
import { createTicketService } from "./tickets/service.js";

// The top folder of the project. It is two levels above this file, both in src/server (when
// run from source) and in dist/server (when run after a build).
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The largest request body the server reads, for JSON and for forms. A larger one is
// refused with 413 before any of it is looked at. The biggest valid ticket is about 6 KB.
const BODY_LIMIT = "100kb";

const picoCssFile = path.join(rootDir, "node_modules/@picocss/pico/css/pico.min.css");

/** Builds the Express app without listening, so tests can drive it directly. */
export function createApp(config: Config, db: Db): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(rootDir, "views"));

  // One ticket service, shared by the JSON API and the pages, so the rules exist once.
  const tickets = createTicketService(db, config.ticketPrefix);

  // Security headers on every answer. The content security policy lets a page load scripts
  // and styles only from this server, so a script written into a page cannot run.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "style-src": ["'self'"],
          // Browsers are told to switch to HTTPS only in production. On a development
          // machine the server speaks plain HTTP and the switch would break the page.
          "upgrade-insecure-requests": config.nodeEnv === "production" ? [] : null,
        },
      },
    }),
  );

  app.use(cookieParser());
  app.use(actorMiddleware(config));

  // The JSON API. Its own handlers at the end turn every error inside it into JSON.
  const api = express.Router();
  api.use(express.json({ limit: BODY_LIMIT }));
  api.use(healthRouter(config, db));
  api.use(ticketsRouter(tickets));
  api.use(notFoundHandler);
  api.use(errorHandler);
  app.use("/api", api);

  // The pages: two stylesheets, the HTML form parser, the routes, then HTML error pages.
  app.get("/assets/pico.min.css", (_req, res) => {
    res.sendFile(picoCssFile);
  });
  app.use("/assets", express.static(path.join(rootDir, "public")));
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  app.use(signInRouter(config));
  app.use(pagesRouter(tickets));
  app.use(pageNotFoundHandler);
  app.use(pageErrorHandler);

  return app;
}
