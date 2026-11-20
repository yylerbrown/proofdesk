import { z } from "zod";
import { DEFAULT_SCOPES, DEMO_CONNECTION_HOURS } from "../connections/service.js";
import { HINTS } from "../errors.js";
import { WRITE_LIMIT_DESCRIPTION } from "../limits.js";
import { AGENT_SCOPES, CAPABILITIES } from "../permissions.js";
import { TOOL_ACTIONS } from "../mcp.js";
import { ACTIONS, type ApiAction } from "./actions.js";
import type { Actor } from "../actor.js";
import { maySuggestChecks, suggestionSetting } from "../tickets/access.js";
import { guide, LISTEN_TEXT, SUGGEST_CHECKS_TEXT, UNTRUSTED_TEXT } from "./describe.js";

// One page for an AI assistant to read once, served at /llms.txt and /llms-full.txt. It is
// written as Markdown and built from the same action table, capability table and zod schemas
// as the JSON API, the MCP tools, GET /api and /api/openapi.json, so it cannot drift from them.

/** The part of a JSON Schema this page reads to describe one field. */
type FieldSchema = {
  type?: string;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  required?: string[];
};

/** A zod schema as JSON Schema, the way a caller sends it. */
function jsonSchemaOf(schema: z.ZodType): FieldSchema {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as FieldSchema;
}

/** One field's type and limits in a few words, such as "text, 3 to 120 characters". */
function describeType(field: FieldSchema): string {
  if (field.enum) return `one of ${field.enum.map((v) => `\`${String(v)}\``).join(", ")}`;
  if (field.type === "string") {
    if (field.minLength && field.maxLength)
      return `text, ${field.minLength} to ${field.maxLength} characters`;
    if (field.maxLength) return `text, up to ${field.maxLength} characters`;
    return "text";
  }
  if (field.type === "integer") return "whole number";
  if (field.type === "array") {
    const count = field.maxItems ? `, up to ${field.maxItems}` : "";
    const item = field.items?.properties
      ? `objects with ${Object.keys(field.items.properties).join(", ")}`
      : describeType(field.items ?? {});
    return `list of ${item}${count}`;
  }
  return field.type ?? "any value";
}

/** The fields an action takes, one line each. */
function inputLines(row: ApiAction): string[] {
  const lines: string[] = [];
  if (row.path.includes(":key"))
    lines.push("- `key` (required): the ticket's key, such as SUP-42.");
  for (const schema of [row.query, row.body]) {
    if (schema === undefined) continue;
    const json = jsonSchemaOf(schema);
    for (const [name, field] of Object.entries(json.properties ?? {})) {
      const required = json.required?.includes(name) ? "required" : "optional";
      // The version check is explained once, under Rules, so it is not repeated here.
      const about =
        name === "expected_version" ? "the version you read" : (field.description ?? "");
      lines.push(`- \`${name}\` (${required}, ${describeType(field)})${about ? `: ${about}` : ""}`);
    }
  }
  return lines.length > 0 ? ["Inputs:", "", ...lines] : ["Inputs: none."];
}

/** Who may call an action, and what an assistant needs, for each permission it names. */
function whoMay(row: ApiAction): string[] {
  const lines = [row.needs].flat().map((need) => {
    const { people, agent } = CAPABILITIES[need];
    const forAgents =
      agent === "people_only"
        ? "Never an assistant."
        : `An assistant needs the scope \`${agent}\`.`;
    return `${people} ${forAgents}`;
  });
  if (lines.length === 1) return [`Who may: ${lines[0]}`];
  const needs = [row.needs].flat();
  return ["Who may:", "", ...lines.map((line, i) => `- For \`${needs[i]}\`: ${line}`)];
}

/**
 * The refusals that follow from the action's shape: its ticket key, its fields, its version
 * check and its idempotency key. The ones every action shares are said once, above the list.
 */
function refusalLine(row: ApiAction): string {
  const codes: string[] = [];
  if (row.path.includes(":key")) codes.push("ticket_not_found");
  if (row.body || row.query) codes.push("validation_error");
  const body = row.body ? jsonSchemaOf(row.body) : {};
  if (body.properties?.expected_version) codes.push("ticket_changed");
  if (row.method !== "get") codes.push("idempotency_key_reused");
  return `Also refused with: ${codes.map((c) => `\`${c}\``).join(", ")}.`;
}

/** One action, as a short section. */
function actionSection(row: ApiAction): string {
  const door = TOOL_ACTIONS.includes(row) ? `MCP tool \`${row.name}\`` : "not an MCP tool";
  return [
    `### ${row.name}`,
    "",
    `\`${row.method.toUpperCase()} /api${row.path}\`, ${door}.`,
    "",
    row.summary,
    "",
    ...inputLines(row),
    "",
    ...whoMay(row),
    "",
    refusalLine(row),
  ].join("\n");
}

/**
 * The whole page, for a server at this address. Read with the key of a connection allowed to
 * suggest ways to verify new tickets, it says how to do that too.
 */
export function llmsText(address: string, reader: Actor | null = null): string {
  const g = guide(null, address);
  const rules = g.start_here;
  const scopeRows = AGENT_SCOPES.map((scope) => {
    const opens = Object.entries(CAPABILITIES)
      .filter(([, c]) => c.agent === scope)
      .map(([action]) => action);
    const onByDefault = DEFAULT_SCOPES.includes(scope) ? "yes" : "no";
    return `| \`${scope}\` | ${onByDefault} | ${opens.join(", ")} |`;
  });
  const peopleOnly = Object.entries(CAPABILITIES)
    .filter(([, c]) => c.agent === "people_only")
    .map(([action]) => action);
  const example = rules.steps.flatMap((s, i) => {
    const lines = [`${i + 1}. ${s.step}`];
    if ("mcp" in s)
      lines.push(
        `   - MCP: \`${s.mcp}\``,
        "   - HTTP:",
        "",
        "     ```",
        `     ${s.http}`,
        "     ```",
        "",
      );
    return lines;
  });

  return (
    [
      "# Proofdesk",
      "",
      `> ${g.about} A named person on the team owns each ticket through New, In Progress and Resolved.`,
      "> An assistant connects with a key an admin gives it, reads the tickets handed to it, writes notes and attaches evidence; a person decides everything else.",
      "",
      "This page is everything an assistant needs, in one read. It is built from the same table as the JSON API and the MCP tools. The same text is at /llms.txt and /llms-full.txt.",
      "",
      "## Connect",
      "",
      "| What | Value |",
      "| --- | --- |",
      `| MCP endpoint (streamable HTTP) | ${address}/mcp |`,
      `| JSON API | ${address}/api |`,
      "| Header on every request | `Authorization: Bearer <key>` |",
      "| Where a key comes from | An admin issues one on the Connections page; it is shown once. On the demo, **Get a demo connection** on the About this demo page gives one that lasts " +
        `${DEMO_CONNECTION_HOURS} hours at most. |`,
      `| The guide, as JSON | ${address}/api (no key needed; with a key it says what your connection may do) |`,
      `| OpenAPI description | ${address}/api/openapi.json |`,
      "",
      "Claude Code:",
      "",
      "```",
      `claude mcp add --transport http proofdesk ${address}/mcp --header "Authorization: Bearer <key>"`,
      "```",
      "",
      "Any program:",
      "",
      "```",
      `curl -H "Authorization: Bearer <key>" ${address}/api/tickets`,
      "```",
      "",
      "Over MCP, each tool takes the fields listed under Actions as its input, plus `idempotency_key` on a write. Over HTTP, `key` is in the path, the other fields are the JSON body (or the query, for a list), and the idempotency key is the `Idempotency-Key` header.",
      "",
      "## Rules",
      "",
      `- ${UNTRUSTED_TEXT}`,
      `- ${rules.ownership}`,
      "- Why a person decides: a test can pass while the customer is still stuck, so only the customer's own Yes counts as confirmed.",
      `- ${rules.done_when}`,
      `- ${rules.no_check}`,
      `- ${rules.blocked}`,
      `- ${rules.retries}`,
      "- Every ticket has a `version`. Send `expected_version`, the version you read, and a change from an old read is refused with 409 `ticket_changed` instead of writing over a newer one. Leave it out to skip the check.",
      `- ${rules.paging}`,
      `- ${rules.results}`,
      `- Limits: ${WRITE_LIMIT_DESCRIPTION}`,
      `- ${rules.stop}`,
      "",
      ...(reader !== null && suggestionSetting(reader) !== "off"
        ? ["## Answering people who ask", "", LISTEN_TEXT, ""]
        : []),
      ...(reader !== null && maySuggestChecks(reader)
        ? ["## Suggesting ways to verify", "", SUGGEST_CHECKS_TEXT, ""]
        : []),
      "## What an assistant may do",
      "",
      "A connection holds scopes. Each scope opens the actions named beside it.",
      "",
      "| Scope | On by default | Opens |",
      "| --- | --- | --- |",
      ...scopeRows,
      "",
      `Never an assistant, whatever it holds: ${peopleOnly.join(", ")}.`,
      "",
      "## Actions",
      "",
      "Every action, with its inputs, who may call it, and its refusals. Any action can be refused with `not_signed_in`, `invalid_connection_key`, `forbidden` (your role or scopes do not allow it) or `too_many_requests`. A request the ticket's state does not allow is refused with 409 and a code from Errors that says what to do first.",
      "",
      ACTIONS.map(actionSection).join("\n\n"),
      "",
      "## Errors",
      "",
      "Every error has this shape. `fields` comes only with `validation_error`, naming each field and what is wrong.",
      "",
      "```json",
      '{ "error": { "code": "validation_error", "message": "...", "hint": "...", "retry": false, "fields": { "title": ["..."] } } }',
      "```",
      "",
      "`retry` says whether sending the same request again can work. The hint says what to do next:",
      "",
      "| Code | What to do |",
      "| --- | --- |",
      ...Object.entries(HINTS).map(([code, hint]) => `| \`${code}\` | ${hint} |`),
      "",
      "## A worked example",
      "",
      "From finding a ticket to asking its owner for a review:",
      "",
      ...example,
    ].join("\n") + "\n"
  );
}
