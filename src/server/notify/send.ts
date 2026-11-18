import type { SendMailOptions, Transporter } from "nodemailer";
import { z } from "zod";
import type { Db } from "../db.js";
import { emailMeOf } from "../people/repository.js";
import { buildKey } from "../tickets/keys.js";
import { NOT_SENT_REASONS } from "./outbox.js";
import * as repository from "./repository.js";

// Sending: the pending notices go out through a mail server, one after another. Each one is
// claimed in a transaction right before its own send. The claim counts the try and holds the
// notice for a while (the lease), so two processes or two timer ticks never send it twice. A
// failed try then waits longer each time, and after the last one the notice is failed and keeps
// its reason.

/** How many notices one call sends at most. The next call carries on. */
export const SEND_BATCH = 5;

/** How many times a notice is tried before it is failed. */
export const MOST_ATTEMPTS = 5;

const MINUTE = 60 * 1000;

/**
 * How long a claim keeps everyone else off a notice while it is being sent. It is far longer
 * than one send can take with the mail server's waits (MAIL_TIMEOUTS in notifier.ts), and each
 * notice is claimed only when its own send starts, so the lease never has to cover another one.
 * A try that is cut off (the server stopping mid-send) is tried again once the lease is over.
 */
export const CLAIM_LEASE_MS = 15 * MINUTE;

/** How long to wait after each failed try before the next one: after the first, a minute. */
export const RETRY_WAITS_MS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE];

/** What sending needs to know. */
export type SendSettings = {
  /** The address notices are sent from. */
  from: string;
  /** The ticket key prefix, such as "SUP". */
  ticketPrefix: string;
};

/**
 * Sends the notices that are due, one after another, at most SEND_BATCH. Returns how many were
 * sent and how many tries failed. A database closed during a try (the server stopping) ends the
 * call quietly, and the notices not yet reached keep their tries.
 */
export async function sendDueNotices(
  db: Db,
  transport: Transporter,
  settings: SendSettings,
  now: () => Date = () => new Date(),
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < SEND_BATCH; i += 1) {
    if (!db.open) break;
    const notice = claimNext(db, now());
    if (notice === null) break;
    const problem = problemWith(notice);
    if (problem !== null) {
      repository.markFailed(db, notice.id, now().toISOString(), problem);
      failed += 1;
      continue;
    }
    let error: string | null = null;
    try {
      await transport.sendMail(messageOf(notice, settings));
    } catch (err) {
      error = plainReason(err);
    }
    // The server may have stopped while the mail was on its way. The notice keeps its claim and
    // is tried again once the lease is over.
    if (!db.open) break;
    const at = now();
    if (error === null) {
      repository.markSent(db, notice.id, at.toISOString());
      sent += 1;
    } else if (notice.attempts >= MOST_ATTEMPTS) {
      repository.markFailed(db, notice.id, at.toISOString(), error);
      failed += 1;
    } else {
      const wait = RETRY_WAITS_MS[notice.attempts - 1]!;
      const next = new Date(at.getTime() + wait).toISOString();
      repository.markRetry(db, notice.id, at.toISOString(), error, next);
      failed += 1;
    }
  }
  return { sent, failed };
}

/**
 * Claims the oldest notice that is due, in one transaction that takes the write lock first. A
 * notice already tried the most times (its last try was cut off) is failed here rather than
 * sent, and one whose recipient has since switched email off is kept as not sent. Returns the
 * claimed notice with its try counted, or null when none is due.
 */
function claimNext(db: Db, now: Date): repository.NoticeRow | null {
  const claim = db.transaction((): repository.NoticeRow | null => {
    const at = now.toISOString();
    for (;;) {
      const [notice] = repository.dueNotices(db, at, 1);
      if (notice === undefined) return null;
      if (notice.attempts >= MOST_ATTEMPTS) {
        repository.markFailed(db, notice.id, at, "The last try was cut off, so it was not sent.");
        continue;
      }
      // The "Email me about my tickets" switch is read again here, so switching it off also
      // stops the notices already waiting.
      if (!emailMeOf(db, notice.recipient_id)) {
        repository.markNotSent(db, notice.id, at, NOT_SENT_REASONS.switchedOff);
        continue;
      }
      const leaseEnds = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
      if (!repository.claimNotice(db, notice.id, notice.attempts, at, leaseEnds)) return null;
      return { ...notice, attempts: notice.attempts + 1, next_attempt_at: leaseEnds };
    }
  });
  return claim.immediate();
}

const address = z.email();

/** Why a notice cannot be sent at all, or null when it can. */
function problemWith(notice: repository.NoticeRow): string | null {
  // A line break in a header would let the text after it add a header of its own. The subject
  // is written on one line, so this is a second guard.
  if (/[\r\n]/.test(notice.subject) || /[\r\n]/.test(notice.address)) {
    return "The subject or address had a line break, so it was not sent.";
  }
  if (!address.safeParse(notice.address).success) {
    return "The address is not a valid email address, so it was not sent.";
  }
  return null;
}

/** The domain of an email address, used to make the message ids of this site. */
function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/**
 * The mail for one notice: plain text, marked as sent by a machine. Its message id never
 * changes, and every notice about one ticket refers to the same ticket id, so a mail client
 * shows them as one conversation.
 */
export function messageOf(notice: repository.NoticeRow, settings: SendSettings): SendMailOptions {
  const domain = domainOf(settings.from);
  const ticketKey = buildKey(settings.ticketPrefix, notice.ticket_id);
  const thread = `<ticket-${ticketKey}@${domain}>`;
  return {
    from: { name: "Proofdesk", address: settings.from },
    to: notice.address,
    subject: notice.subject,
    text: notice.body,
    messageId: `<notice-${notice.id}@${domain}>`,
    references: thread,
    inReplyTo: thread,
    headers: { "Auto-Submitted": "auto-generated" },
  };
}

// The two parts of a mail error that are safe to keep. Anything else reads as missing.
const mailError = z.object({
  code: z
    .string()
    .regex(/^[A-Z]{2,20}$/)
    .optional()
    .catch(undefined),
  responseCode: z.number().int().min(200).max(599).optional().catch(undefined),
});

/** Plain words for the usual mail errors, by their code. */
const REASONS: Record<string, string> = {
  EAUTH: "The mail server refused the sign-in.",
  ENOAUTH: "The mail server asks for a sign-in, and none is set.",
  ECONNECTION: "The mail server could not be reached.",
  ETIMEDOUT: "The mail server took too long to answer.",
  ESOCKET: "The connection to the mail server failed.",
  EDNS: "The mail server's name could not be looked up.",
  ETLS: "A secure connection to the mail server could not be set up.",
  EENVELOPE: "The mail server refused the address.",
  EMESSAGE: "The mail server refused the message.",
};

/**
 * A short, plain reason for a failed try. Never the error's own message: it could quote the
 * mail server's address, and with it the password. Only its code and the server's answer number.
 */
export function plainReason(err: unknown): string {
  const parsed = mailError.safeParse(err);
  const code = parsed.success ? parsed.data.code : undefined;
  const answer = parsed.success ? parsed.data.responseCode : undefined;
  let reason = code === undefined ? "The mail could not be sent." : REASONS[code];
  if (reason === undefined) reason = `The mail could not be sent (${code}).`;
  return answer === undefined ? reason : `${reason} It answered ${answer}.`;
}
