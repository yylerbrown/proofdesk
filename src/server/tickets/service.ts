import type { Db } from "../db.js";
import { createDemoRecord } from "../demo.js";
import { allowedActions } from "./allowed-actions.js";
import { createAssistants } from "./assistants.js";
import { createConversation } from "./conversation.js";
import { createCustomerQuestion } from "./customer-question.js";
import { createEvidenceAndSpecs } from "./evidence-and-specs.js";
import { createFiling } from "./filing.js";
import { createOnce } from "./once.js";
import { createReads } from "./reads.js";
import * as repository from "./repository.js";
import { createResolveAndReopen } from "./resolve-and-reopen.js";
import { createShared } from "./shared.js";
import type { Budget, ServiceOptions } from "./types.js";
import { createWorkflow } from "./workflow.js";

// The ticket service: the rules for tickets, built here from one file per concern. Routes and
// pages call these functions and nothing else. Input that comes from outside arrives as
// "unknown" and is checked in the service, so no caller can skip the check. Every action takes
// the actor and asks can() in permissions.ts, so no caller can skip that either. Who is asking
// is checked before what they sent: find the ticket, check permission, then check the input.
// Someone who may not act is refused plainly and learns nothing about the input rules.

export type {
  Ask,
  AssistantSignal,
  Budget,
  CustomerAnswer,
  DoneWhen,
  ListNarrowing,
  Resolution,
  ServiceOptions,
  Ticket,
  TicketEntry,
  TicketEvent,
  TicketEvidence,
  TicketSpec,
  TicketStamp,
  WaitingOn,
} from "./types.js";
export { LIST_PAGE_SIZE, THREAD_LIMIT } from "./types.js";

export type TicketService = ReturnType<typeof createTicketService>;

const PREFIX_META_KEY = "ticket_prefix";

/**
 * Keys such as SUP-42 are built from the prefix on every read, so the prefix must never
 * change for a database that already has tickets. The first start writes the prefix into
 * the database. Every later start must be configured with the same one.
 */
function pinPrefix(db: Db, prefix: string): void {
  const stored = repository.getMeta(db, PREFIX_META_KEY);
  if (stored === undefined) {
    repository.insertMeta(db, PREFIX_META_KEY, prefix);
    return;
  }
  if (stored !== prefix) {
    throw new Error(
      `TICKET_PREFIX is "${prefix}" but this database was created with "${stored}". ` +
        `Set TICKET_PREFIX back to "${stored}".`,
    );
  }
}

export function createTicketService(
  db: Db,
  prefix: string,
  budget: Budget = {},
  options: ServiceOptions = {},
) {
  const teamMembers = options.teamMembers ?? (() => []);
  // Without a list of the team, nobody is known to have left it.
  const isOnTeam = (personId: string) =>
    options.teamMembers === undefined || teamMembers().some((member) => member.id === personId);
  pinPrefix(db, prefix);
  const shared = createShared(db, prefix, budget);

  return {
    // reads.ts: listTickets, countTickets, visibleKey, getTicket, ticketStamp, listEvents,
    // reopenedByCustomer, peopleRoles, peopleNames, hasNoTickets
    ...createReads(shared, options),
    // filing.ts: createTicket, editTicket, adoptCheck, agreeCheck, linkChange, archiveTicket,
    // restoreTicket, deleteTicket
    ...createFiling(shared),
    // workflow.ts: changeStatus, takeTicket, takeAndStart, releaseTicket, handOff,
    // handOffCandidates
    ...createWorkflow(shared, teamMembers),
    // resolve-and-reopen.ts: resolveWithReason, reopen
    ...createResolveAndReopen(shared, isOnTeam),
    // customer-question.ts: markReady, withdrawQuestionAsked, answer
    ...createCustomerQuestion(shared),
    // conversation.ts: addEntry, addNote, askOwnerToReview, requestReview, listEntries
    ...createConversation(shared),
    // evidence-and-specs.ts: addEvidence, listEvidence, getSpec, proposeSpec, decideSpec
    ...createEvidenceAndSpecs(shared),
    // assistants.ts: giveToAgent, endAgentWork, connectedAssistants, agentHelp, assistantSignals
    ...createAssistants(shared),
    // once.ts: once, the retry-safe wrapper around a write
    ...createOnce(db, prefix),
    // ../demo.ts: recordDemoSeed, hasDemoSeed, assistantSampleKey, recordedRunKey
    ...createDemoRecord(db, prefix, shared.logEvent),
    // allowed-actions.ts: which controls a page shows
    allowedActions,
  };
}
