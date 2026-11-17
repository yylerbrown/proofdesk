import express, { type Express } from "express";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { healthRouter } from "./routes/health.js";

/** Builds the Express app without listening, so tests can drive it directly. */
export function createApp(config: Config, db: Db): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  const api = express.Router();
  api.use(healthRouter(config, db));
  api.use(notFoundHandler);
  app.use("/api", api);

  app.use(errorHandler);
  return app;
}
