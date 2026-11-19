import type http from "node:http";
import { loadConfig } from "./config.js";
import { createDemoReset } from "./demo-reset.js";
import { createNotifier } from "./notify/notifier.js";
import { startServer } from "./serve.js";
import { openSite, type Site } from "./start.js";

// Every line goes to standard output, where the host collects it.
const log = (line: string) => console.log(line);

const config = loadConfig();
const site = openSite(config, log);

// The demo goes back to its samples by itself when it is quiet (src/server/demo-reset.ts), so its
// requests go to whichever app is current. The real site serves its one app and never resets.
const demoReset = config.demo ? createDemoReset({ config, log, site }) : null;
const current = (): Site => (demoReset === null ? site : demoReset.current());
// Email notices are collected after every answered request that changed something, and on a
// timer, always from the current site's database (src/server/notify/notifier.ts).
const notifier = createNotifier({ config, currentDb: () => current().db, log });
const handler: http.RequestListener = notifier.afterChanges(
  demoReset === null ? site.app : demoReset.handler,
);

const running = startServer({
  handler,
  port: config.port,
  closeDatabase: () => {
    const { db } = current();
    if (db.open) db.close();
  },
  log,
  exit: (code) => process.exit(code),
});
void running.listening.then((port) => {
  log(`Listening on port ${port}`);
  demoReset?.start();
  notifier.start();
});

// The host sends SIGTERM (fly.toml sets it) before it replaces or stops the machine; Ctrl+C
// sends SIGINT. A second signal while stopping changes nothing: the first stop has a deadline.
// The demo's reset timer and the notifier's timer stop first, so neither starts while requests
// finish.
function stop(reason: string) {
  demoReset?.stop();
  notifier.stop();
  void running.shutdown(reason);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
