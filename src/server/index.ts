import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { seedDemo } from "./demo.js";
import { startServer } from "./serve.js";
import { openAndMigrate } from "./start.js";
import { createTicketService } from "./tickets/service.js";

// Every line goes to standard output, where the host collects it.
const log = (line: string) => console.log(line);

const config = loadConfig();
// A database labelled for the other purpose is refused before any migration touches it.
const { db, applied } = openAndMigrate(config);
if (applied.length > 0) log(`Applied migrations: ${applied.join(", ")}`);
// createApp checks the database's purpose first, so the demo is only seeded into a demo
// database. It logs one line per request.
const app = createApp(config, db, { log });
if (config.demo) {
  const service = createTicketService(db, config.ticketPrefix);
  seedDemo(service);
  // A database filled by older code has no record of its samples, and assistant connections
  // stay off until it is reset. Say so where an operator looks first.
  if (!service.hasDemoSeed()) {
    console.warn(
      "This demo's database was filled before its samples were recorded, so assistant " +
        "connections are off. Reset it: docs/DEPLOY.md, Resetting the demo.",
    );
  }
}

const running = startServer({
  handler: app,
  port: config.port,
  db,
  log,
  exit: (code) => process.exit(code),
});
void running.listening.then((port) => log(`Listening on port ${port}`));

// The host sends SIGTERM (fly.toml sets it) before it replaces or stops the machine; Ctrl+C
// sends SIGINT. A second signal while stopping changes nothing: the first stop has a deadline.
process.on("SIGTERM", () => void running.shutdown("SIGTERM"));
process.on("SIGINT", () => void running.shutdown("SIGINT"));
