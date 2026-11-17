import { DEMO_ACTORS } from "./actor.js";
import type { TicketService } from "./tickets/service.js";

/**
 * Fills an empty demo database with a few sample tickets, made through the ticket service
 * like any others, so their history is real. Does nothing if there are tickets already.
 */
export function seedDemo(service: TicketService): void {
  // The three demo people, in the order DEMO_ACTORS lists them.
  const customer = DEMO_ACTORS[0]!;
  const team = DEMO_ACTORS[1]!;
  // Demo people cannot archive, so the sample data has no archived ticket.
  // Archived tickets count too, or archiving every sample would make the next start seed
  // a second set.
  if (!service.hasNoTickets()) return;

  const login = service.createTicket(
    {
      title: "Cannot sign in on my phone",
      description: "The sign-in button does nothing on my phone. It works on my laptop.",
      where_url: "https://example.com/sign-in",
      fix_check: "I can sign in on my phone",
    },
    customer,
  );
  service.addEntry(login.key, { kind: "reply", body: "Which phone and browser is it?" }, team);
  service.addEntry(
    login.key,
    { kind: "note", body: "Probably the button script failing on older Safari." },
    team,
  );
  service.addEntry(login.key, { kind: "reply", body: "An older iPhone, with Safari." }, customer);
  service.takeTicket(login.key, team);
  service.changeStatus(login.key, { status: "in_progress" }, team);
  service.agreeCheck(
    login.key,
    { agreed_check: "Sign-in works on Safari on iPhone, on the oldest supported version" },
    team,
  );

  service.createTicket(
    {
      title: "Invoice shows the wrong date",
      description: "My invoice for March says February.",
      fix_check: "The invoice shows March",
    },
    customer,
  );

  service.createTicket(
    { title: "Test ticket, please ignore", description: "Filed by mistake." },
    customer,
  );
}
