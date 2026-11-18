import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { seedDemo } from "./demo.js";
import { openAndMigrate } from "./start.js";
import { createTicketService } from "./tickets/service.js";

const config = loadConfig();
// A database labelled for the other purpose is refused before any migration touches it.
const { db, applied } = openAndMigrate(config);
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`);
// createApp checks the database's purpose first, so the demo is only seeded into a demo
// database.
const app = createApp(config, db);
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

const server = app.listen(config.port, () => {
  console.log(`Listening on port ${config.port}`);
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
