import { createHash } from "node:crypto";
import { z } from "zod";
import { DEMO_ACTORS, type Actor } from "./actor.js";
import type { Db } from "./db.js";
import { writeDatedSample, type DatedSample } from "./demo-past-sample.js";
import { OTHER_DEMO_CUSTOMERS } from "./demo-people.js";
import { forbidden, HttpError } from "./errors.js";
import { requirePermission } from "./tickets/checks.js";
import * as repository from "./tickets/repository.js";
import type { ResolveReason } from "./tickets/schemas.js";
import { parse } from "./validation.js";

// On the demo, "Add sample tickets" on About this demo files a batch of made-up tickets, so a
// visitor has a fuller list to filter, sort and search. Everything here is made up. The tickets
// are planned from a seed, so the same seed always plans the same tickets, and a test can pin
// them. The demo's reset removes them with every other visitor's tickets.

/** How many tickets one press may add. */
export const SAMPLE_BATCH_SIZES = ["10", "25", "50"] as const;

/** Over how long the batch was filed, with the words the form shows and the days each covers. */
export const SAMPLE_BATCH_PERIODS = {
  week: { label: "The last week", days: 7 },
  month: { label: "The last month", days: 30 },
  quarter: { label: "The last three months", days: 90 },
} as const;

/** What the form sends. */
export const sampleBatchSchema = z.object({
  count: z.enum(SAMPLE_BATCH_SIZES).transform(Number),
  period: z.enum(["week", "month", "quarter"]),
});

export type SampleBatchInput = z.infer<typeof sampleBatchSchema>;

type Problem = { title: string; description: string; fixCheck: string | null };

/** Plain support problems, written for the batch. About two in three say what proves the fix. */
export const SAMPLE_PROBLEMS: Problem[] = [
  {
    title: "Order history is empty",
    description: "My order history page says I have no orders, but I ordered twice last month.",
    fixCheck: "My order history lists both of last month's orders",
  },
  {
    title: "Photo upload stops at 99%",
    description: "Uploading a profile photo gets to 99% and then nothing happens.",
    fixCheck: "My new profile photo shows after the upload finishes",
  },
  {
    title: "Wrong time zone on my bookings",
    description: "Every booking shows an hour later than the time I picked.",
    fixCheck: "A new booking shows the time I picked",
  },
  {
    title: "Cannot remove an old address",
    description: "The delete button next to my old address does nothing.",
    fixCheck: "The old address is gone from my saved addresses",
  },
  {
    title: "Newsletter keeps coming after I unsubscribed",
    description: "I unsubscribed two weeks ago and still get the newsletter every Monday.",
    fixCheck: null,
  },
  {
    title: "Page is blank after the update",
    description: "Since this morning the dashboard shows a white page.",
    fixCheck: "The dashboard loads with my numbers on it",
  },
  {
    title: "Discount code says it has expired",
    description: "The code from your email is meant to work until the end of the month.",
    fixCheck: "The code takes the discount off my basket",
  },
  {
    title: "Charged twice for one order",
    description: "My bank shows two payments of the same amount a minute apart.",
    fixCheck: "One of the two payments is refunded",
  },
  {
    title: "Two-step sign-in code not accepted",
    description: "I type the code from my app and it says the code is wrong.",
    fixCheck: "I can sign in with the code from my app",
  },
  {
    title: "Report downloads with no rows",
    description: "The monthly report downloads, but the file has only the column names.",
    fixCheck: "The downloaded report has a row for every day of the month",
  },
  {
    title: "Search is very slow",
    description: "A search takes about twenty seconds to show anything.",
    fixCheck: null,
  },
  {
    title: "Calendar invite has the wrong date",
    description: "The invite in my email is for the day after the meeting.",
    fixCheck: "The invite shows the same date as the meeting page",
  },
  {
    title: "Cannot change my email address",
    description: "Saving a new email address shows an error and keeps the old one.",
    fixCheck: "My account shows the new email address after saving",
  },
  {
    title: "Mobile menu does not open",
    description: "On my phone, tapping the menu icon does nothing.",
    fixCheck: "Tapping the menu icon on my phone opens the menu",
  },
  {
    title: "Prices show without tax",
    description: "The basket shows prices before tax, then the total jumps at checkout.",
    fixCheck: "The basket shows prices with tax included",
  },
  {
    title: "Shared folder asks for access again",
    description: "My colleague shared a folder with me, and it still says I need access.",
    fixCheck: "I can open the shared folder without asking again",
  },
  {
    title: "Notifications arrive hours late",
    description: "A message sent at nine reached my phone at noon.",
    fixCheck: "A test message reaches my phone within a minute",
  },
  {
    title: "Print view cuts off the last column",
    description: "Printing an invoice cuts off the amount column on the right.",
    fixCheck: "A printed invoice shows every column",
  },
  {
    title: "Account locked after one wrong password",
    description: "I typed my password wrong once and now my account is locked.",
    fixCheck: "I can sign in again after one wrong try",
  },
  {
    title: "Uploaded file has the wrong name",
    description: "Every file I upload is renamed to a long string of numbers.",
    fixCheck: null,
  },
  {
    title: "Delivery tracking link is broken",
    description: "The tracking link in my order email opens a page that says not found.",
    fixCheck: "The tracking link shows where my parcel is",
  },
  {
    title: "Chart shows last year's numbers",
    description: "The sales chart on the home page still shows last year.",
    fixCheck: "The chart shows this year's numbers",
  },
  {
    title: "Gift card balance not applied",
    description: "I entered my gift card at checkout, and the full price was charged to my card.",
    fixCheck: "The gift card amount is refunded to my card",
  },
  {
    title: "Language switches back to English",
    description: "I set the site to French, and every new page is in English again.",
    fixCheck: "Pages stay in French after I choose it",
  },
  {
    title: "Exported dates are in the wrong order",
    description: "Dates in the exported file read month first, but my settings say day first.",
    fixCheck: null,
  },
  {
    title: "Team member cannot see a project",
    description: "I added a new team member to a project, and they say it is not in their list.",
    fixCheck: null,
  },
  {
    title: "Reminder emails go to spam",
    description: "Our customers say the appointment reminders end up in their spam folder.",
    fixCheck: null,
  },
  {
    title: "Subscription renewed after cancelling",
    description: "I cancelled before the renewal date and was still charged for another year.",
    fixCheck: null,
  },
  {
    title: "Map shows the wrong store",
    description: "The store page for the north branch shows a map of the south branch.",
    fixCheck: null,
  },
  {
    title: "Password rules are not explained",
    description: "The new password form says my password is not strong enough, but not why.",
    fixCheck: null,
  },
  {
    title: "Video stops after a minute",
    description: "Training videos stop playing after about a minute and will not resume.",
    fixCheck: null,
  },
  {
    title: "Contact form gives no confirmation",
    description: "I sent the contact form three times and never saw a message that it went.",
    fixCheck: null,
  },
  {
    title: "Invoice total does not match the lines",
    description: "The lines on my invoice add up to less than the total at the bottom.",
    fixCheck: "The invoice total equals the sum of its lines",
  },
  {
    title: "Cannot sign out on a shared computer",
    description: "After signing out, pressing Back shows my account page again.",
    fixCheck: "After signing out, Back shows the sign-in page",
  },
  {
    title: "Sorting by price puts ten before two",
    description: "Sorting products by price lists 10.00 before 2.00.",
    fixCheck: "Sorting by price lists 2.00 before 10.00",
  },
  {
    title: "Attachment missing from the reply",
    description: "I attached a screenshot to my reply, and the reply arrived without it.",
    fixCheck: "My next reply with a screenshot arrives with it",
  },
  {
    title: "Points not added after a purchase",
    description: "My last three purchases did not add any points to my rewards balance.",
    fixCheck: "My rewards balance includes the points for those purchases",
  },
  {
    title: "Form forgets what I typed",
    description: "When the form shows an error, everything I typed is gone.",
    fixCheck: "The form keeps what I typed when it shows an error",
  },
  {
    title: "Welcome email has a broken image",
    description: "The welcome email shows an empty box where the picture should be.",
    fixCheck: null,
  },
  {
    title: "Phone number with spaces is refused",
    description: "The form says my phone number is not valid when I type it with spaces.",
    fixCheck: null,
  },
  {
    title: "Weekly summary arrives on Tuesday",
    description: "The weekly summary is meant to come on Monday morning, but it comes on Tuesday.",
    fixCheck: null,
  },
  {
    title: "Dark mode resets every visit",
    description: "I turn on dark mode, and next time I visit it is light again.",
    fixCheck: "Dark mode is still on when I come back",
  },
  {
    title: "Coupon field is hidden on mobile",
    description: "On my phone there is no place to type a coupon code at checkout.",
    fixCheck: "I can type a coupon code at checkout on my phone",
  },
  {
    title: "Receipt email lists the wrong items",
    description: "My receipt email lists items from someone else's order.",
    fixCheck: null,
  },
];

/** The team's own reasons for the batch's tickets resolved without the customer's Yes. */
const TEAM_REASONS: { reason: ResolveReason; note: string | null }[] = [
  { reason: "fixed_no_reply", note: null },
  { reason: "cannot_reproduce", note: null },
  { reason: "wont_fix", note: "This works as designed. The help page now says so." },
  { reason: "other", note: "Answered by phone. Nothing to change." },
];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A pseudo-random number from 0 up to 1, the same for the same seed and step. It is a hash of
 * the two, so it needs no state and no library beyond Node's own.
 */
function chance(seed: number, step: string): number {
  const digest = createHash("sha256").update(`${seed}:${step}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/** A whole number from low up to high, both included. */
function between(seed: number, step: string, low: number, high: number): number {
  return low + Math.floor(chance(seed, step) * (high - low + 1));
}

/**
 * A believable filing time within the period: a random day, at a random minute between 15:00
 * and 23:59 UTC, which is working hours on the Pacific coast. Never later than an hour ago.
 */
function filedTime(seed: number, n: number, days: number, now: number): number {
  const dayStart = (ms: number) => ms - (ms % DAY);
  const day = dayStart(now) - between(seed, `${n}:day`, 0, days - 1) * DAY;
  let at =
    day + between(seed, `${n}:hour`, 15, 23) * HOUR + between(seed, `${n}:minute`, 0, 59) * MINUTE;
  while (at > now - HOUR) at -= DAY;
  return at;
}

/** The same time if it falls in working hours, otherwise 15:00 UTC that day, at the same minute. */
function inWorkingHours(ms: number): number {
  const hour = new Date(ms).getUTCHours();
  return hour >= 15 ? ms : ms + (15 - hour) * HOUR;
}

/**
 * Plans a batch of made-up tickets. The same seed and time always plan the same tickets. Each is
 * filed by one of the customers, at a believable time within the period. About a quarter are
 * still New. The rest were taken by the team member a few hours later, and about two thirds of
 * those were resolved a day or so after: some confirmed by their customer, some by the team with
 * its own reason. A step that would fall in the last ten minutes is left out, so every step
 * happened before now.
 */
export function planSampleBatch(
  seed: number,
  input: SampleBatchInput,
  customers: Actor[],
  team: Actor,
  now: Date,
): DatedSample[] {
  const days = SAMPLE_BATCH_PERIODS[input.period].days;
  const latest = now.getTime() - 10 * MINUTE;
  // The pool is shuffled once for the batch, and a batch larger than the pool goes round again.
  const order = SAMPLE_PROBLEMS.map((_, index) => index).sort(
    (a, b) => chance(seed, `order:${a}`) - chance(seed, `order:${b}`),
  );
  const plans: DatedSample[] = [];
  for (let n = 0; n < input.count; n++) {
    const problem = SAMPLE_PROBLEMS[order[n % order.length]!]!;
    const filer = customers[between(seed, `${n}:filer`, 0, customers.length - 1)]!;
    const filed = filedTime(seed, n, days, now.getTime());
    const plan: DatedSample = {
      title: problem.title,
      description: problem.description,
      fixCheck: problem.fixCheck,
      filer,
      filedAt: new Date(filed).toISOString(),
    };
    plans.push(plan);

    // About one in four stays New.
    if (chance(seed, `${n}:stays-new`) < 0.25) continue;
    // The team takes and resolves tickets in working hours too.
    const taken = inWorkingHours(filed + between(seed, `${n}:taken`, 20, 6 * 60) * MINUTE);
    if (taken > latest) continue;
    plan.taken = { by: team, at: new Date(taken).toISOString() };

    // About one in three of the taken tickets is still in progress.
    if (chance(seed, `${n}:in-progress`) < 1 / 3) continue;
    const resolved = inWorkingHours(
      taken + between(seed, `${n}:resolved`, 2 * 60, 3 * 24 * 60) * MINUTE,
    );
    if (resolved > latest) continue;
    // A ticket with a proof is mostly confirmed by its customer; the rest the team resolves.
    const confirmed = problem.fixCheck !== null && chance(seed, `${n}:confirmed`) < 0.7;
    const confirmedAt = resolved + between(seed, `${n}:confirmed-at`, 30, 20 * 60) * MINUTE;
    const byTeam = TEAM_REASONS[between(seed, `${n}:reason`, 0, TEAM_REASONS.length - 1)]!;
    plan.resolved = confirmed
      ? {
          reason: "fixed_no_reply",
          note: null,
          at: new Date(resolved).toISOString(),
          confirmedAt: new Date(Math.min(confirmedAt, latest)).toISOString(),
        }
      : { ...byTeam, at: new Date(resolved).toISOString(), confirmedAt: null };
  }
  return plans;
}

/** Where the demo writes: its database, its key prefix and the service's writer of History. */
export type DemoPlace = { db: Db; prefix: string; logEvent: (event: repository.NewEvent) => void };

/**
 * On the demo, files a batch of made-up tickets for a visitor who asked for a fuller list,
 * planned from the seed, each with its History at its own past times. mostTickets is how many
 * tickets the demo may hold once the batch is in. The caller sets it below the demo's budget, so
 * batches leave room for visitors' own tickets. When a batch would not fit, nothing is filed and
 * the answer is 409. The tickets are not in the seeding record, so no assistant connection is shown
 * them, and nothing is sent for them. Returns how many were filed.
 */
export function fileSampleBatch(
  place: DemoPlace,
  mostTickets: number,
  input: unknown,
  actor: Actor,
  seed: number,
  now: Date,
): number {
  if (actor.demo !== true) throw forbidden(actor);
  requirePermission(actor, "create");
  const batch = parse(sampleBatchSchema, input);
  const { db, prefix, logEvent } = place;
  if (repository.countTickets(db) + batch.count > mostTickets) {
    throw new HttpError(409, "budget_full", "The demo has no room for more sample tickets.");
  }
  // The demo customer and the other made-up customers file them; the demo's team member works them.
  const customers = [DEMO_ACTORS[0]!, ...OTHER_DEMO_CUSTOMERS];
  const plans = planSampleBatch(seed, batch, customers, DEMO_ACTORS[1]!, now);
  // Filed oldest first, so the keys run in the order the tickets were filed.
  plans.sort((a, b) => a.filedAt.localeCompare(b.filedAt));
  db.transaction(() => {
    for (const plan of plans) writeDatedSample(db, prefix, logEvent, plan);
  })();
  return plans.length;
}
