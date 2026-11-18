import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Config } from "./config.js";
import type { LogLine } from "./http-basics.js";
import { openSite, type Site } from "./start.js";
import { allIds, findTicket } from "./tickets/repository.js";

// The public demo is one database that every visitor writes to. Once a day, when nobody is
// using it, it goes back to its samples by itself: the database files are moved aside on the
// same disk, and a fresh database is opened and seeded in their place. Only the demo does
// this. The real site never builds one of these.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** How often the demo looks, and how old and how quiet it must be before it resets. */
export type ResetTimes = {
  /** How often the timer checks. */
  checkEveryMs: number;
  /** The samples must be at least this old. */
  oldAfterMs: number;
  /** And no request may have arrived for this long. */
  quietForMs: number;
  /** Samples this old are reset even if the demo is never quiet that long. */
  forcedAfterMs: number;
};

export const RESET_TIMES: ResetTimes = {
  checkEveryMs: 5 * MINUTE,
  oldAfterMs: 24 * HOUR,
  quietForMs: 15 * MINUTE,
  forcedAfterMs: 48 * HOUR,
};

/** How many earlier databases stay on the disk, set aside. Older ones are deleted. */
export const KEEP_SET_ASIDE = 3;

/** The database file and the two companion files SQLite keeps beside it. */
function databaseFiles(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

/** A set-aside name, as the manual reset uses: the file's name, then the time it was moved. */
const SET_ASIDE = /\.before-reseed-(\d{8}-\d{6})$/;

/** A time as 20261118-142501, in UTC, for set-aside names that sort by time. */
function stamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/** When the samples were seeded: the time the first ticket was filed, or now if none was. */
function seededAt(site: Site, now: number): number {
  const first = Math.min(...allIds(site.db, "tickets"));
  const ticket = Number.isFinite(first) ? findTicket(site.db, first) : undefined;
  return ticket === undefined ? now : Date.parse(ticket.created_at);
}

export type DemoReset = {
  /** Answers every request with the current app, and notes when requests come and go. */
  handler: http.RequestListener;
  /** The app and database serving now. */
  current: () => Site;
  /** Resets now if the demo is old enough and quiet enough. True when it reset. */
  check: () => boolean;
  /** Checks once now, then starts the timer that checks. */
  start: () => void;
  /** Stops the timer. */
  stop: () => void;
};

/**
 * Wraps the demo's site so it can be replaced while the server runs. A reset happens inside
 * one timer callback with no await in it, so no request can be answered half by the old
 * database and half by the new one.
 */
export function createDemoReset(options: {
  config: Config;
  log: LogLine;
  site: Site;
  times?: ResetTimes;
  now?: () => number;
  /** Moves a file. Tests pass one that fails. */
  rename?: (from: string, to: string) => void;
}): DemoReset {
  const { config, log } = options;
  // Only the demo's data is ever thrown away like this.
  if (!config.demo) throw new Error("Only the demo resets itself.");
  const times = options.times ?? RESET_TIMES;
  const now = options.now ?? Date.now;
  const rename = options.rename ?? fs.renameSync;
  const databasePath = path.resolve(config.databasePath);

  let site = options.site;
  let samplesFrom = seededAt(site, now());
  let inFlight = 0;
  // When the last request other than a health check arrived or ended, or null if none has.
  let lastRequestAt: number | null = null;
  let timer: NodeJS.Timeout | null = null;

  const handler: http.RequestListener = (req, res) => {
    // The host checks /api/health every 30 seconds. Those checks are not visitors, so they
    // do not keep the demo from being quiet.
    const visitor = !(req.url ?? "").startsWith("/api/health");
    inFlight += 1;
    if (visitor) lastRequestAt = now();
    res.on("close", () => {
      inFlight -= 1;
      if (visitor) lastRequestAt = now();
    });
    site.app(req, res);
  };

  function check(): boolean {
    const age = now() - samplesFrom;
    if (age < times.oldAfterMs) return false;
    // A request being answered always waits for the next check, so its database is never
    // closed under it.
    if (inFlight > 0) return false;
    const quiet = lastRequestAt === null || now() - lastRequestAt >= times.quietForMs;
    if (!quiet && age < times.forcedAfterMs) return false;
    return reset();
  }

  /** Moves the database aside and serves a freshly seeded one. False when it failed. */
  function reset(): boolean {
    const at = now();
    const moved: [string, string][] = [];
    site.db.close();
    try {
      for (const file of databaseFiles(databasePath)) {
        if (!fs.existsSync(file)) continue;
        const aside = `${file}.before-reseed-${stamp(at)}`;
        rename(file, aside);
        moved.push([file, aside]);
      }
      site = openSite(config, log, false);
    } catch (err) {
      putBack(moved);
      const reason = err instanceof Error ? err.message : String(err);
      log(`The demo could not reset (${reason}), so it keeps its data and tries again later.`);
      // The old files are back where they were. If even they cannot be opened, the error
      // goes up to the timer, which logs it and stops the process rather than serve nothing.
      site = openSite(config, log, false);
      return false;
    }
    samplesFrom = at;
    removeOldCopies();
    log(`The demo reset to its samples. Its earlier data is set aside as ${stamp(at)}.`);
    return true;
  }

  /**
   * Undoes the moves of a failed reset: each old file returns to its place. A move replaces a
   * new file of the same name, and a fresh database that failed to open was closed again,
   * which removes its companion files.
   */
  function putBack(moved: [string, string][]): void {
    for (const [file, aside] of moved) fs.renameSync(aside, file);
  }

  /** Deletes set-aside copies beyond the newest few. A failure here is logged, not fatal. */
  function removeOldCopies(): void {
    const folder = path.dirname(databasePath);
    const names = new Set(databaseFiles(databasePath).map((file) => path.basename(file)));
    try {
      const asides = fs.readdirSync(folder).filter((name) => {
        const match = SET_ASIDE.exec(name);
        return match !== null && names.has(name.slice(0, match.index));
      });
      const stamps = [...new Set(asides.map((name) => SET_ASIDE.exec(name)![1]!))].sort();
      const keep = new Set(stamps.slice(-KEEP_SET_ASIDE));
      for (const name of asides) {
        if (!keep.has(SET_ASIDE.exec(name)![1]!)) fs.rmSync(path.join(folder, name));
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`The demo reset, but older set-aside copies could not be removed (${reason}).`);
    }
  }

  return {
    handler,
    current: () => site,
    check,
    start: () => {
      if (timer !== null) return;
      // A demo restarted with old samples, and nobody using it yet, resets at once.
      check();
      timer = setInterval(check, times.checkEveryMs);
      // The timer alone never keeps the process running.
      timer.unref();
    },
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
