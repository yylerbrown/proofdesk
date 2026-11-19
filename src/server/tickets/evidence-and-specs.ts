import type { Actor } from "../actor.js";
import { HttpError, ValidationError } from "../errors.js";
import { can } from "../permissions.js";
import { parse } from "../validation.js";
import { isDemoAgent } from "./access.js";
import { requireNotArchived, requirePermission, requireRoom } from "./checks.js";
import { addEvidenceSchema } from "./evidence.js";
import * as repository from "./repository.js";
import { decideSpecSchema, proposeSpecSchema } from "./spec.js";
import type { Shared } from "./shared.js";
import { THREAD_LIMIT, type TicketEvidence, type TicketSpec } from "./types.js";

// Evidence that the customer's check was met, and the test spec that says how it is checked.
// Both are stored as reported: Proofdesk verifies none of it, and neither changes the status.

export function createEvidenceAndSpecs(shared: Shared) {
  const { db, budget, requireRow, log, toEvidence, toSpec } = shared;

  /**
   * The spec this actor sees on a ticket: the one in force, or for a demo agent the latest it
   * proposed itself, so one visitor's assistant never reads another's.
   */
  function specFor(ticketId: number, actor: Actor): repository.SpecRow | undefined {
    if (isDemoAgent(actor)) return repository.findLatestSpecBy(db, ticketId, actor.id);
    const spec = repository.findActiveSpec(db, ticketId);
    // A proposed spec is a suggestion for the team to decide on. A customer sees the spec only
    // once a person on the team has accepted it.
    if (spec?.state === "proposed" && actor.kind === "person" && actor.role === "customer") {
      return undefined;
    }
    return spec;
  }

  return {
    /**
     * Attaches evidence that the check was met, and its history entry, together. It is stored
     * as reported. It never changes the ticket's status: only a person resolves one.
     */
    addEvidence(key: string, input: unknown, actor: Actor): TicketEvidence {
      const row = db.transaction(() => {
        const ticket = requireRow(key, actor);
        requirePermission(actor, "attach_evidence", ticket);
        const evidence = parse(addEvidenceSchema, input);
        requireNotArchived(key, ticket);
        requireRoom(
          () => repository.countRows(db, "ticket_evidence", ticket.id),
          budget.evidencePerTicket,
          "evidence on this ticket",
        );
        // Evidence may name the scenario of the ticket's test spec that it proves.
        const spec = evidence.scenario === undefined ? undefined : specFor(ticket.id, actor);
        if (evidence.scenario !== undefined && spec === undefined) {
          throw new HttpError(
            409,
            "no_spec",
            `Ticket ${key} has no test spec, so evidence cannot name a scenario. Leave scenario out, or propose a spec first.`,
          );
        }
        if (spec !== undefined && evidence.scenario! > JSON.parse(spec.scenarios).length) {
          throw new ValidationError(`The spec has no scenario ${evidence.scenario}.`, {
            scenario: [`The spec has no scenario ${evidence.scenario}.`],
          });
        }
        const now = new Date().toISOString();
        const saved = repository.insertEvidence(db, {
          ticket_id: ticket.id,
          kind: evidence.kind,
          summary: evidence.summary,
          link: evidence.link ?? null,
          revision: evidence.revision ?? null,
          command: evidence.command ?? null,
          result: evidence.result ?? null,
          report: evidence.report === undefined ? null : JSON.stringify(evidence.report),
          author: actor.id,
          author_kind: actor.kind,
          author_name: actor.name,
          connection_id: actor.connection?.id ?? null,
          spec_id: spec?.id ?? null,
          scenario: evidence.scenario ?? null,
          created_at: now,
        });
        log(
          ticket.id,
          actor,
          "evidence_added",
          { kind: evidence.kind, summary: evidence.summary },
          now,
        );
        return saved;
      })();
      return toEvidence(row);
    },

    /**
     * The evidence on a ticket, oldest first. Whoever may read the ticket may read it, with
     * these limits: a customer sees an assistant's evidence only once the owner has asked them,
     * and never a raw report; a demo connection sees only its own.
     */
    listEvidence(key: string, actor: Actor): TicketEvidence[] {
      const ticket = requireRow(key, actor);
      // A raw report is for the team. The customer sees the summary, link and stages.
      const forTeam = can(actor, "read_notes", ticket);
      const customer = actor.kind === "person" && actor.role === "customer";
      // An assistant's evidence reaches the customer only once the owner has asked them, having
      // reviewed it. A scenario number means nothing to them until the team accepts the spec.
      const asked =
        ticket.ready_at !== null || repository.latestAnswer(db, ticket.id) !== undefined;
      const specAccepted = repository.findActiveSpec(db, ticket.id)?.state === "accepted";
      const evidence = repository
        .listEvidence(db, ticket.id, THREAD_LIMIT)
        .map(toEvidence)
        .filter((item) => !customer || asked || item.reported_by.kind !== "agent")
        .map((item) => (forTeam ? item : { ...item, report: null }))
        .map((item) => (customer && !specAccepted ? { ...item, scenario: null } : item));
      // No sample ticket comes with evidence, so a demo connection sees only its own.
      return isDemoAgent(actor) ? evidence.filter((e) => e.reported_by.id === actor.id) : evidence;
    },

    /**
     * The ticket's test spec, or null when it has none yet. A demo agent sees only the spec it
     * proposed itself.
     */
    getSpec(key: string, actor: Actor): TicketSpec | null {
      const row = requireRow(key, actor);
      const spec = specFor(row.id, actor);
      return spec === undefined ? null : toSpec(spec, actor);
    },

    /**
     * Proposes a test spec, which replaces the one in force; the old one is kept as
     * "replaced". It is a suggestion until a person accepts it, and never changes the status.
     */
    proposeSpec(key: string, input: unknown, actor: Actor): TicketSpec {
      const row = db.transaction(() => {
        const ticket = requireRow(key, actor);
        requirePermission(actor, "propose_spec", ticket);
        const spec = parse(proposeSpecSchema, input);
        requireNotArchived(key, ticket);
        requireRoom(
          () => repository.countSpecs(db, ticket.id),
          budget.specsPerTicket,
          "specs on this ticket",
        );
        const now = new Date().toISOString();
        const saved = repository.insertSpec(db, {
          ticket_id: ticket.id,
          summary: spec.summary,
          scenarios: JSON.stringify(spec.scenarios),
          author: actor.id,
          author_kind: actor.kind,
          author_name: actor.name,
          connection_id: actor.connection?.id ?? null,
          created_at: now,
        });
        log(ticket.id, actor, "spec_proposed", { scenarios: spec.scenarios.length }, now);
        return saved;
      })();
      return toSpec(row, actor);
    },

    /** A person on the team accepts the proposed spec as the agreed way to test, or discards it. */
    decideSpec(key: string, input: unknown, actor: Actor): TicketSpec {
      const row = db.transaction(() => {
        const ticket = requireRow(key, actor);
        requirePermission(actor, "decide_spec", ticket);
        const { decision } = parse(decideSpecSchema, input);
        requireNotArchived(key, ticket);
        const spec = repository.findActiveSpec(db, ticket.id);
        if (spec === undefined) {
          throw new HttpError(409, "no_spec", `Ticket ${key} has no test spec to decide on.`);
        }
        if (decision === "accept" && spec.state === "accepted") return spec; // already
        const state = decision === "accept" ? "accepted" : "discarded";
        const now = new Date().toISOString();
        repository.decideSpec(db, spec.id, state, actor, now);
        log(ticket.id, actor, decision === "accept" ? "spec_accepted" : "spec_discarded", {}, now);
        return repository.findSpec(db, spec.id)!;
      })();
      return toSpec(row, actor);
    },
  };
}
