import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const applied = runMigrations(db);
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`);

const server = createApp(config, db).listen(config.port, () => {
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
