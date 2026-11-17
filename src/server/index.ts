import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { seedDemo } from "./demo.js";
import { runMigrations } from "./migrate.js";
import { createTicketService } from "./tickets/service.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const applied = runMigrations(db);
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`);
// createApp checks the database's purpose first, so the demo is only seeded into a demo
// database.
const app = createApp(config, db);
if (config.demo) seedDemo(createTicketService(db, config.ticketPrefix));

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
