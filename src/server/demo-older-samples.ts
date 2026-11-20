import type { Actor } from "./actor.js";
import type { TicketService } from "./tickets/service.js";

/**
 * Two of the demo's samples, resolved weeks ago, so the ticket list's "Resolved:" filter has
 * older tickets to show. The demo's seed files them after its other samples, so no other
 * sample's key changes. One is the demo customer's, marked fixed by the team and then confirmed
 * by them, 20 days ago. Another customer's was resolved as Won't fix, 35 days ago. Each is
 * written with its own past times, History included.
 */
export function seedOlderSamples(
  service: TicketService,
  team: Actor,
  customer: Actor,
  otherCustomer: Actor,
): void {
  service.seedPastSample({
    title: "Two-factor code arrives after it expires",
    description: "The code in the text message has already expired when it reaches my phone.",
    fixCheck: "A new code arrives while it still works",
    filer: customer,
    team,
    resolvedDaysAgo: 20,
    reason: "fixed_no_reply",
    note: null,
    confirmed: true,
  });

  service.seedPastSample({
    title: "Export to CSV drops accents",
    description: "Words such as café and naïve lose their accents in the exported file.",
    fixCheck: "An exported word keeps its accents",
    filer: otherCustomer,
    team,
    resolvedDaysAgo: 35,
    reason: "wont_fix",
    note: "The export follows the spreadsheet's own text setting.",
    confirmed: false,
  });
}
