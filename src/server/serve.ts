import http from "node:http";
import type { Db } from "./db.js";
import type { LogLine } from "./http-basics.js";

/**
 * How long requests already being answered get to finish after a stop is asked for. The
 * host waits 10 seconds after its stop signal before it kills the process (kill_timeout in
 * fly.toml and fly.proofdesk.toml), so this ends first.
 */
export const DRAIN_MS = 8000;

export type Running = {
  server: http.Server;
  /** Resolves with the port once the server is listening (useful when asked for port 0). */
  listening: Promise<number>;
  /** Stops cleanly. Calling it again returns the same promise. */
  shutdown: (reason: string) => Promise<void>;
};

/**
 * Listens on the port and knows how to stop cleanly: stop taking new connections, let the
 * requests in flight finish (up to drainMs), close the database, then exit 0. A port that is
 * already taken prints one line and exits 1.
 */
export function startServer(options: {
  handler: http.RequestListener;
  port: number;
  db: Db;
  log: LogLine;
  exit: (code: number) => void;
  drainMs?: number;
}): Running {
  const { handler, port, db, log, exit } = options;
  const drainMs = options.drainMs ?? DRAIN_MS;
  let stopping: Promise<void> | null = null;

  const server = http.createServer((req, res) => {
    // A request that arrives on an open connection while stopping is still answered, but
    // the connection closes after it, so the browser reconnects to the next server.
    if (stopping !== null) res.setHeader("Connection", "close");
    // A request already in flight when the stop began: once its answer is sent, its
    // connection is closed too, rather than kept open for a next request that never comes.
    res.on("finish", () => {
      if (stopping !== null) setImmediate(() => server.closeIdleConnections());
    });
    handler(req, res);
  });

  const listening = new Promise<number>((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        log(`Port ${port} is already in use, so the server did not start.`);
      } else {
        log(`The server could not start: ${error.message}`);
      }
      if (db.open) db.close();
      exit(1);
    });
    server.listen(port, () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });

  function shutdown(reason: string): Promise<void> {
    if (stopping !== null) return stopping;
    stopping = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        if (db.open) db.close();
        log("Stopped.");
        resolve();
        exit(0);
      };
      log(`Stopping (${reason}): finishing requests in flight, then closing the database.`);
      // Requests still running after the allowance are cut off, so the database closes and
      // the process exits before the host kills it.
      const deadline = setTimeout(() => {
        log(`Requests still open after ${drainMs} ms were closed.`);
        server.closeAllConnections();
        finish();
      }, drainMs);
      // Stops listening; calls back once every request is done and its connection closed.
      server.close(finish);
      // Connections kept open between requests are closed now rather than at their timeout.
      server.closeIdleConnections();
    });
    return stopping;
  }

  return { server, listening, shutdown };
}
