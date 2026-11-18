import type { SendMailOptions, Transporter } from "nodemailer";
import { z } from "zod";
import type { Db } from "../db.js";
import { buildKey } from "../tickets/keys.js";
import * as repository from "./repository.js";

// Sending: the pending notices go out through a mail server, a few at a time. Each one is first
// claimed in a transaction, which counts the try and moves its next time forward, so two
// processes or two timer ticks never send the same notice. A failed try waits longer each time,
// and after the last one the notice is failed and keeps its reason.

/** How many notices one call sends at most. The next call carries on. */
export const SEND_BATCH = 5;

/** How many times a notice is tried before it is failed. */
export const MOST_ATTEMPTS = 5;

const MINUTE = 60 * 1000;

/**
 * How long to wait after each try before the next one: after the first, a minute, and so on.
 * Each wait is longer than one try can take (see MAIL_TIMEOUTS in notifier.ts), because the
 * claim uses the wait to keep everyone else off the notice while it is being sent.
 */
export const RETRY_WAITS_MS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE, 60 * MINUTE];

/** What sending needs to know. */
export type SendSettings = {
  /** The address notices are sent from. */
  from: string;
  /** The ticket key prefix, such as "SUP". */
  ticketPrefix: string;
};

/**
 * Sends the notices that are due, one after another. Returns how many were sent and how many
 * tries failed. A database closed during a try (the server stopping) ends the call quietly.
 */
export async function sendDueNotices(
  db: Db,
  transport: Transporter,
  settings: SendSettings,
  now: () => Date = () => new Date(),
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const notice of claimDue(db, now())) {
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
    // is tried again once its wait is over.
    if (!db.open) break;
    const at = now().toISOString();
    if (error === null) {
      repository.markSent(db, notice.id, at);
      sent += 1;
    } else if (notice.attempts >= MOST_ATTEMPTS) {
      repository.markFailed(db, notice.id, at, error);
      failed += 1;
    } else {
      repository.markRetry(db, notice.id, at, error);
      failed += 1;
    }
  }
  return { sent, failed };
}

/**
 * Claims the notices that are due, in one transaction that takes the write lock first. A notice
 * already tried the most times (its last try was cut off) is failed here rather than sent.
 * Returns the claimed notices, each with its try counted.
 */
function claimDue(db: Db, now: Date): repository.NoticeRow[] {
  const claim = db.transaction(() => {
    const at = now.toISOString();
    const claimed: repository.NoticeRow[] = [];
    for (const notice of repository.dueNotices(db, at, SEND_BATCH)) {
      if (notice.attempts >= MOST_ATTEMPTS) {
        repository.markFailed(db, notice.id, at, "The last try was cut off, so it was not sent.");
        continue;
      }
      const wait = RETRY_WAITS_MS[notice.attempts]!;
      const next = new Date(now.getTime() + wait).toISOString();
      if (repository.claimNotice(db, notice.id, notice.attempts, at, next)) {
        claimed.push({ ...notice, attempts: notice.attempts + 1, next_attempt_at: next });
      }
    }
    return claimed;
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
