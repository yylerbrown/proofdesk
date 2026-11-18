import type http from "node:http";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config, MailConfig } from "../config.js";
import type { Db } from "../db.js";
import type { LogLine } from "../http-basics.js";
import { collectNotices, notifySettingsOf } from "./outbox.js";
import { sendDueNotices } from "./send.js";

// The notifier collects notices from the ticket history and sends the pending ones. It runs
// right after any request that changed something has been answered, and on a short timer as a
// safety net. It never runs inside a request, so a slow mail server never slows a page. Each
// run reads the database the site is serving now: the demo swaps in a fresh one when it resets.

/** How often the timer runs, in case a run after a request was missed. */
export const NOTIFY_EVERY_MS = 5000;

/**
 * How long nodemailer waits for the mail server at each stage. Together they stay well under
 * the shortest wait between tries (RETRY_WAITS_MS in send.ts).
 */
export const MAIL_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
};

export type Notifier = {
  /** Collects and sends now. Resolves once this run, and any asked for during it, is done. */
  run: () => Promise<void>;
  /** Asks for a run as soon as the current work is done. */
  soon: () => void;
  /** Wraps a request handler so that a run follows every answered request that changed something. */
  afterChanges: (handler: http.RequestListener) => http.RequestListener;
  /** Starts the timer. */
  start: () => void;
  /** Stops the timer. No new run starts after this. */
  stop: () => void;
};

/** The mail server connection for these settings. */
export function mailTransport(mail: MailConfig): Transporter {
  return nodemailer.createTransport({ url: mail.smtpUrl, ...MAIL_TIMEOUTS });
}

/** Requests that only read never change anything, so they need no run after them. */
const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

export function createNotifier(options: {
  config: Config;
  /** The database the site serves now. */
  currentDb: () => Db;
  log: LogLine;
  /** Tests pass one of nodemailer's own test transports. */
  transport?: Transporter;
  everyMs?: number;
}): Notifier {
  const { config, currentDb, log } = options;
  const settings = notifySettingsOf(config);
  // The demo, or a server with no mail settings, only writes its notices as not sent.
  const mail = config.mail;
  const transport = mail === null ? null : (options.transport ?? mailTransport(mail));
  const everyMs = options.everyMs ?? NOTIFY_EVERY_MS;

  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function once(): Promise<void> {
    const db = currentDb();
    if (!db.open) return;
    try {
      collectNotices(db, settings);
    } catch (err) {
      // A database error holds no setting, so its message is safe to log.
      log(`Notices could not be collected: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (transport === null || mail === null) return;
    const result = await sendDueNotices(db, transport, {
      from: mail.from,
      ticketPrefix: config.ticketPrefix,
    });
    if (result.failed > 0) {
      log(`Email notices: ${result.sent} sent, ${result.failed} not sent this time.`);
    }
  }

  function run(): Promise<void> {
    if (running !== null) {
      // Collect again once the current run is done, so nothing written during it waits.
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await once();
        } while (again && !stopped);
      } catch (err) {
        log(`Email notices stopped with an error: ${err instanceof Error ? err.name : "error"}.`);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function soon(): void {
    if (stopped) return;
    setImmediate(() => {
      if (!stopped) void run();
    });
  }

  return {
    run,
    soon,
    afterChanges: (handler) => (req, res) => {
      // "finish" fires once the answer is sent, after the request's transaction is done.
      if (!READ_ONLY.has(req.method ?? "GET")) res.on("finish", soon);
      handler(req, res);
    },
    start: () => {
      if (timer !== null || stopped) return;
      if (transport !== null) log("Email notices are sent through the mail server that is set.");
      else if (!config.demo) log("Email notices are kept, not sent: no mail server is set.");
      timer = setInterval(() => void run(), everyMs);
      // The timer alone never keeps the process running.
      timer.unref();
      void run();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
