import type { Actor } from "../actor.js";
import { readDemoSeed } from "../demo.js";
import { HttpError, ValidationError } from "../errors.js";
import { can } from "../permissions.js";
import { parse } from "../validation.js";
import { requireNotArchived, requirePermission, requireVersion, saved } from "./checks.js";
import { parseKey } from "./keys.js";
import * as repository from "./repository.js";
import { giveToAgentSchema, versionOnlySchema } from "./schemas.js";
import type { Shared } from "./shared.js";
import type { AssistantSignal, Ticket } from "./types.js";

// Handing a ticket to the team's own AI assistant, ending that, and what the team's pages show
// about assistants: which connection has a ticket, and what one last said it needs.

export function createAssistants(shared: Shared) {
  const { db, prefix, requireRow, log, endAgent, toTicket } = shared;

  return {
    /**
     * The owner hands an in-progress ticket to one agent connection, which can then work on it
     * within its scopes. A ticket has at most one; handing it to another ends the first. While
     * the customer is answering a question, no agent is given the ticket.
     */
    giveToAgent(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "hand_to_agent", before);
        const { connection_id, expected_version } = parse(giveToAgentSchema, input);
        requireNotArchived(key, before);
        if (before.owner_id !== actor.id) {
          throw new HttpError(
            403,
            "not_owner",
            `Only ${before.owner_name ?? "its owner"}, who owns ticket ${key}, hands it to an agent.`,
          );
        }
        if (before.status !== "in_progress") {
          throw new HttpError(409, "not_in_progress", `Start work on ticket ${key} first.`);
        }
        // Asking the customer ends any agent's work, so no agent works while they answer.
        if (before.ready_at !== null) {
          throw new HttpError(
            409,
            "question_open",
            `The customer is answering a question on ${key}. Withdraw it first to hand the ticket to an assistant.`,
          );
        }
        const now = new Date().toISOString();
        const connection = repository.liveConnections(db, now).find((c) => c.id === connection_id);
        if (connection === undefined) {
          throw new ValidationError("Choose a connection that is not revoked.", {
            connection_id: ["Choose a connection that is not revoked."],
          });
        }
        if (repository.activeHandoff(db, before.id)?.connection_id === connection.id) return before;
        requireVersion(key, before, expected_version);
        endAgent(before, "handed to another agent", actor, now);
        repository.startHandoff(db, before.id, connection.id, actor.id, now);
        log(before.id, actor, "agent_handed", { connection: connection.name }, now);
        return before;
      })();
      return toTicket(saved(db, row), actor);
    },

    /** The owner, or an admin, ends an agent's work on the ticket. */
    endAgentWork(key: string, actor: Actor, input: unknown = {}): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "hand_to_agent", before);
        const { expected_version } = parse(versionOnlySchema, input ?? {});
        if (before.owner_id !== actor.id && actor.role !== "admin") {
          throw new HttpError(
            403,
            "not_owner",
            `Only the owner of ticket ${key}, or an admin, can end it.`,
          );
        }
        // Archiving already ended any assistant's work.
        requireNotArchived(key, before);
        if (repository.activeHandoff(db, before.id) === undefined) return before; // nothing to end
        requireVersion(key, before, expected_version);
        endAgent(before, "ended by a person", actor, new Date().toISOString());
        return before;
      })();
      return toTicket(saved(db, row), actor);
    },

    /** How many assistant connections people have issued that can work right now. */
    connectedAssistants(): number {
      return repository.liveConnections(db, new Date().toISOString()).length;
    },

    /** Which agent connection is working on the ticket now, and which it could be handed to. */
    agentHelp(ticket: Ticket) {
      const id = parseKey(prefix, ticket.key)!;
      return {
        current: repository.activeHandoff(db, id) ?? null,
        candidates: repository.liveConnections(db, new Date().toISOString()),
        // On the demo, the sample made for assistants is handed to every visitor's connection.
        demoSample: readDemoSeed(db)?.assistant === id,
      };
    },

    /**
     * For the team: what an open ticket's assistant last said it needs, from its latest note.
     * "Assistant blocked: <first line>" until it writes an ordinary note again, or "Review
     * requested by <connection>" until the owner asks the customer. Nothing for anyone who may
     * not read internal notes.
     */
    assistantSignals(tickets: Ticket[], actor: Actor): Map<string, AssistantSignal> {
      const open = new Map<number, Ticket>();
      for (const ticket of tickets) {
        if (ticket.status === "resolved" || !can(actor, "read_notes", ticket)) continue;
        const id = parseKey(prefix, ticket.key);
        if (id !== null) open.set(id, ticket);
      }
      const signals = new Map<string, AssistantSignal>();
      for (const note of repository.latestAgentNotes(db, [...open.keys()])) {
        const ticket = open.get(note.ticket_id)!;
        if (note.blocked === 1) {
          const firstLine = note.body.split("\n")[0]!.trim().slice(0, 140);
          signals.set(ticket.key, { label: "Assistant blocked:", text: firstLine });
        } else if (note.purpose === "review_request" && ticket.ready_at === null) {
          signals.set(ticket.key, { label: "Review requested by", text: note.author_name });
        }
      }
      return signals;
    },
  };
}
