import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import type { Config } from "../config.js";
import { isDatabaseOk, type Db } from "../db.js";

function readVersion(): string {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
  return pkg.version ?? "unknown";
}

const version = readVersion();

export function healthRouter(config: Config, db: Db): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    const databaseOk = isDatabaseOk(db);
    res.status(databaseOk ? 200 : 503).json({
      status: databaseOk ? "ok" : "degraded",
      version,
      commit: config.gitCommit ?? null,
      database: databaseOk ? "ok" : "error",
    });
  });
  return router;
}
