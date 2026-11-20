import type { Actor } from "./actor.js";
import type { TicketService } from "./tickets/service.js";

/**
 * Two of the demo's samples, resolved weeks ago, so the ticket list's "Resolved:" filter has
 * older tickets to show. The demo's seed files them after its other samples, so no other
 * sample's key changes. One is the demo customer's, marked fixed by the team and then confirmed
 * by them, 20 days ago. Another customer's was resolved as Won't fix, 35 days ago.
 */
export function seedOlderSamples(
  service: TicketService,
  team: Actor,
  customer: Actor,
  otherCustomer: Actor,
): void {
  const twoFactor = service.createTicket(
    {
      title: "Two-factor code arrives after it expires",
      description: "The code in the text message has already expired when it reaches my phone.",
      fix_check: "A new code arrives while it still works",
    },
    customer,
  );
  service.takeAndStart(twoFactor.key, team);
  service.resolveWithReason(twoFactor.key, { reason: "fixed_no_reply" }, team);
  service.confirmFix(twoFactor.key, {}, customer);
  service.moveDemoSampleBack(twoFactor.key, 20);

  const accents = service.createTicket(
    {
      title: "Export to CSV drops accents",
      description: "Words such as café and naïve lose their accents in the exported file.",
      fix_check: "An exported word keeps its accents",
    },
    otherCustomer,
  );
  service.takeAndStart(accents.key, team);
  service.resolveWithReason(
    accents.key,
    { reason: "wont_fix", note: "The export follows the spreadsheet's own text setting." },
    team,
  );
  service.moveDemoSampleBack(accents.key, 35);
}
