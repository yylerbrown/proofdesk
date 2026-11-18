import type http from "node:http";
import { loadConfig } from "./config.js";
import { createDemoReset } from "./demo-reset.js";
import { startServer } from "./serve.js";
import { openSite, type Site } from "./start.js";

// Every line goes to standard output, where the host collects it.
const log = (line: string) => console.log(line);

const config = loadConfig();
const site = openSite(config, log);

// The demo goes back to its samples by itself once a day (src/server/demo-reset.ts), so its
// requests go to whichever app is current. The real site serves its one app and never resets.
const demoReset = config.demo ? createDemoReset({ config, log, site }) : null;
const handler: http.RequestListener = demoReset === null ? site.app : demoReset.handler;
const current = (): Site => (demoReset === null ? site : demoReset.current());

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
});

// The host sends SIGTERM (fly.toml sets it) before it replaces or stops the machine; Ctrl+C
// sends SIGINT. A second signal while stopping changes nothing: the first stop has a deadline.
// The demo's reset timer stops first, so no reset starts while requests finish.
function stop(reason: string) {
  demoReset?.stop();
  void running.shutdown(reason);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
