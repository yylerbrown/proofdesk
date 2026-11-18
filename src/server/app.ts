import express, { type Express } from "express";
import { actorMiddleware } from "./actor.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { healthRouter } from "./routes/health.js";
import { ticketsRouter } from "./routes/tickets.js";
import { createTicketService } from "./tickets/service.js";

/** Builds the Express app without listening, so tests can drive it directly. */
export function createApp(config: Config, db: Db): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  const api = express.Router();
  api.use(actorMiddleware);
  api.use(healthRouter(config, db));
  api.use(ticketsRouter(createTicketService(db, config.ticketPrefix)));
  api.use(notFoundHandler);
  app.use("/api", api);

  app.use(errorHandler);
  return app;
}
