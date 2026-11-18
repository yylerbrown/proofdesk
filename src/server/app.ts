import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import { toNodeHandler } from "better-auth/node";
import express, { type Express } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { actorMiddleware, DEMO_ACTORS } from "./actor.js";
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
import { createTicketService, DEMO_BUDGET } from "./tickets/service.js";
import { createConnectionService } from "./connections/service.js";
import { connectionsRouter } from "./routes/connections.js";
import { mcpEndpoint, mcpErrorHandler } from "./mcp.js";
import { assistantRunRouter } from "./routes/assistant-run.js";
import { peopleRoles, teamMembers } from "./team/service.js";
import { guide, openApiDocument } from "./api/describe.js";
import { siteAddress } from "./routes/connections.js";
// The limits live in limits.ts, where the API's guide reads them too.
import { DEMO_CONNECTIONS_PER_HOUR, FILING_LIMIT, SIGN_IN_LIMIT, WRITE_LIMIT } from "./limits.js";

// The top folder of the project. It is two levels above this file, both in src/server (when
// run from source) and in dist/server (when run after a build).
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The largest request body the server reads, for JSON and for forms. A larger one is
// refused with 413 before any of it is looked at. The biggest valid ticket is about 6 KB.
const BODY_LIMIT = "100kb";

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
  // On the demo, the header offers every demo person, to switch role without losing the page.
  app.locals.demoPeople = config.demo ? DEMO_ACTORS : [];

  // One ticket service, shared by the JSON API and the pages, so the rules exist once.
  // The demo has a hard budget of rows, so rate limits are not the only thing that stops it
  // growing. Real tickets have none.
  const tickets = createTicketService(db, config.ticketPrefix, config.demo ? DEMO_BUDGET : {}, {
    teamMembers: teamMembers(config, db),
    peopleRoles: peopleRoles(config, db),
  });
  const connections = createConnectionService(db);

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

  // Limits on how often one person, or one address when signed out, may file a ticket or
  // start a sign-in. Over the limit the answer is 429 until the window has passed.
  const tooMany: Parameters<typeof rateLimit>[0] = {
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // A real person is counted by their account. Demo visitors share three made-up
    // identities, so they are counted by address, like someone not signed in.
    // req.actor is not set on the sign-in library's own routes, which run before it.
    keyGenerator: (req) =>
      req.actor && req.actor.demo !== true ? req.actor.id : ipKeyGenerator(clientAddress(req)),
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
  // A demo visitor may ask for a few assistant connections an hour, counted by address.
  const demoConnectionLimit = rateLimit({
    ...tooMany,
    windowMs: 60 * 60 * 1000,
    limit: DEMO_CONNECTIONS_PER_HOUR,
  });
  // One allowance for every request that changes something, pages and API together.
  const writeLimit = rateLimit({
    ...tooMany,
    windowMs: 10 * 60 * 1000,
    limit: WRITE_LIMIT,
    skip: (req) => req.method === "GET" || req.method === "HEAD",
  });
  // The library's own sign-in routes get the same allowance as starting a GitHub sign-in.
  const authLimit = rateLimit({
    ...tooMany,
    windowMs: 60 * 1000,
    limit: SIGN_IN_LIMIT,
    skip: (req) => req.method === "GET",
  });

  // GitHub sign-in, when its settings are present. The library answers everything under
  // /api/auth itself: the return from GitHub, and its own session routes. It must be
  // mounted before any body parser, because it reads the request body itself.
  const auth = config.signIn === null ? null : createAuth(db, config.signIn, config.clientIpHeader);
  if (auth !== null) {
    // The same forged-request check and a sign-in limit as our own routes, in front of the
    // library's own, which are mounted before everything else.
    app.use("/api/auth", sameOriginOnly(config), authLimit);
    app.all("/api/auth/*splat", toNodeHandler(auth));
  }

  app.use(cookieParser());

  // Decides who is acting on a page. The API has its own copy, which also accepts an
  // agent's connection key, so that a failure inside each is answered in its own format.
  const actor = actorMiddleware(config, auth, db);

  // The JSON API. Its own handlers at the end turn every error inside it into JSON.
  const api = express.Router();
  // The API also accepts an agent's connection key. The pages below do not.
  api.use(actorMiddleware(config, auth, db, connections));
  api.use(sameOriginOnly(config));
  api.use(writeLimit);
  api.post("/tickets", filingLimit);
  api.use(express.json({ limit: BODY_LIMIT }));
  api.use(healthRouter(config, db, () => tickets.hasDemoSeed()));
  // The API describes itself, with no sign-in needed: a guide at /api, and the
  // machine-readable description at /api/openapi.json. With a key, the guide also says what
  // that connection may do.
  const openapi = openApiDocument();
  api.get("/", (req, res) => {
    res.json(guide(req.actor, siteAddress(config, req), config.sourceUrl));
  });
  api.get("/openapi.json", (_req, res) => {
    res.json(openapi);
  });
  api.use(ticketsRouter(tickets, connections));
  api.use(notFoundHandler);
  api.use(errorHandler);
  app.use("/api", api);

  // The MCP endpoint for AI assistants: the same actions as tools, with a connection key.
  app.all("/mcp", ...mcpEndpoint(tickets, connections, writeLimit));
  // Its errors are answered as JSON-RPC errors, before the pages' HTML error handler.
  app.use("/mcp", mcpErrorHandler);

  // The pages: two stylesheets, which need no sign-in and so come before the actor, then
  // the HTML form parser, the routes and the HTML error pages.
  app.get("/assets/pico.min.css", (_req, res) => {
    res.sendFile(picoCssFile);
  });
  // The Inter font files, from its package, so the page needs no font host.
  app.use(
    "/assets/inter",
    express.static(path.join(rootDir, "node_modules/@fontsource/inter/files")),
  );
  app.use("/assets", express.static(path.join(rootDir, "public")));
  app.use(actor);
  app.use(sameOriginOnly(config));
  app.use(writeLimit);
  app.post("/tickets", filingLimit);
  app.post("/sign-in/github", signInLimit);
  app.post("/demo/connection", demoConnectionLimit);
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  app.use(assistantRunRouter(rootDir, () => tickets.recordedRunKey()));
  app.use(signInRouter(config, auth, () => tickets.hasDemoSeed()));
  app.use(pagesRouter(tickets));
  app.use(connectionsRouter(connections, config, () => tickets.hasDemoSeed()));
  app.use(pageNotFoundHandler);
  app.use(pageErrorHandler);

  return app;
}
