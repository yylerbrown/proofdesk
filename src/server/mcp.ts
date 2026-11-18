import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { originValidation, requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Actor } from "./actor.js";
import { ACTIONS, nextCursor, type ApiAction } from "./api/actions.js";
import { MCP_INSTRUCTIONS, UNTRUSTED_TEXT } from "./api/describe.js";
import type { ConnectionService } from "./connections/service.js";
import { errorBody, HttpError } from "./errors.js";
import { CAPABILITIES } from "./permissions.js";
import type { TicketService } from "./tickets/service.js";

// The MCP endpoint: the same actions as the JSON API, as tools an AI assistant can call, built
// with the official SDK over the streamable HTTP transport. Each tool calls the same ticket
// service function as the pages and the JSON API, with the agent as the actor, so every
// permission rule and history entry is shared. Actions that are for people only are not
// offered as tools at all.

/** The actions an agent could ever take: every permission they need is open to some scope. */
export const TOOL_ACTIONS: ApiAction[] = ACTIONS.filter((row) =>
  [row.needs].flat().every((needed) => CAPABILITIES[needed].agent !== "people_only"),
);

/** A tool's input: the ticket key when the action is about one ticket, then its fields. */
function inputSchema(row: ApiAction) {
  return z.object({
    ...(row.method !== "get"
      ? {
          idempotency_key: z.string().min(1).max(100).optional().meta({
            description:
              "Any unique text. Send the same one when retrying, and the write is done only once.",
          }),
        }
      : {}),
    ...(row.path.includes(":key")
      ? {
          key: z.string().max(30).meta({ description: "The ticket's key, for example SUP-42." }),
        }
      : {}),
    ...(row.query?.shape ?? {}),
    ...((row.body as z.ZodObject | undefined)?.shape ?? {}),
  });
}

function text(value: unknown) {
  return [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];
}

/** Builds the MCP server for one request, acting as the agent the key belongs to. */
function buildServer(
  service: TicketService,
  connections: ConnectionService,
  actor: Actor,
): McpServer {
  const server = new McpServer(
    { name: "proofdesk", version: "1.0.0" },
    { instructions: MCP_INSTRUCTIONS },
  );
  // Only the tools this connection may use: a tool its scopes forbid is not offered at all.
  const scopes = actor.scopes ?? [];
  const mayUse = (row: ApiAction) =>
    [row.needs].flat().every((needed) => {
      const scope = CAPABILITIES[needed].agent;
      return scope !== "people_only" && scopes.includes(scope);
    });
  for (const row of TOOL_ACTIONS.filter(mayUse)) {
    server.registerTool(
      row.name,
      { description: `${row.summary} ${UNTRUSTED_TEXT}`, inputSchema: inputSchema(row) },
      async (args: Record<string, unknown>) => {
        const { key, idempotency_key: idempotencyKey, ...fields } = args;
        const ticketKey = typeof key === "string" ? key : "";
        const record = (outcome: "done" | "refused" | "failed", code: string | null) =>
          connections.record(actor, {
            door: "mcp",
            action: row.name,
            ticketKey,
            idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined,
            outcome,
            code,
          });
        try {
          const call = () =>
            row.run({
              service,
              actor,
              key: ticketKey,
              query: row.query ? fields : {},
              body: row.body ? fields : {},
            });
          const ran =
            row.method === "get"
              ? call()
              : service.once(
                  actor,
                  typeof idempotencyKey === "string" ? idempotencyKey : undefined,
                  row.name,
                  ticketKey,
                  fields,
                  call,
                );
          // A list comes in pages: say where the next one starts, or null on the last.
          const result =
            row.paged && Array.isArray(ran)
              ? { items: ran, next_cursor: nextCursor(fields, ran) }
              : ran;
          record("done", null);
          return { content: text({ untrusted_content_note: UNTRUSTED_TEXT, result }) };
        } catch (err) {
          // A refusal is a result the agent can act on: what happened and what to do next.
          if (!(err instanceof HttpError)) {
            record("failed", "internal_error");
            throw err;
          }
          record(err.status < 500 ? "refused" : "failed", err.code);
          return { isError: true, content: text(errorBody(err).body) };
        }
      },
    );
  }
  return server;
}

/** The agent behind a verified key, carried from the bearer check to the tools. */
function actorOf(authInfo: AuthInfo | undefined): Actor {
  const actor = authInfo?.extra?.actor as Actor | undefined;
  if (actor === undefined) throw new HttpError(401, "not_signed_in", "Send a connection key.");
  return actor;
}

/**
 * The middleware for POST /mcp, in order: refuse a browser page from another site, read the
 * JSON body, check the connection key with the SDK's bearer check, refuse a batch, apply the
 * write allowance to tool calls that change something, then hand the request to the SDK's
 * handler.
 */
export function mcpEndpoint(
  service: TicketService,
  connections: ConnectionService,
  writeLimit: RequestHandler,
): RequestHandler[] {
  const verifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const actor = connections.authenticate(token);
      if (actor === null || actor.connection === undefined) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "That connection key is not valid. Keys are shown once: ask an admin to revoke this connection and issue a new one.",
        );
      }
      return {
        token,
        clientId: String(actor.connection.id),
        scopes: actor.scopes ?? [],
        // The key is checked again on every request, so this short window never outlives a
        // revocation by more than one request.
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        extra: { actor },
      };
    },
  };
  const handler = createMcpHandler(({ authInfo }) =>
    buildServer(service, connections, actorOf(authInfo)),
  );
  const node = toNodeHandler(handler);
  const writing = new Set(TOOL_ACTIONS.filter((row) => row.method !== "get").map((r) => r.name));

  return [
    // A browser page may only call this from this site. Programs send no Origin at all.
    (req, res, next) => originValidation([req.hostname])(req, res, next),
    express.json({ limit: "100kb" }),
    requireBearerAuth({ verifier }),
    (req, res, next) => {
      // One JSON-RPC message a request. The SDK would run every call in an array, and the
      // write allowance below counts one call a request. The SDK's own client never batches.
      if (Array.isArray(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message: "Batches are not accepted. Send one JSON-RPC message in one request.",
          },
          id: null,
        });
        return;
      }
      next();
    },
    (req, res, next) => {
      const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
      const call = body?.method === "tools/call" ? body.params?.name : undefined;
      if (typeof call === "string" && writing.has(call)) {
        // The same allowance as the JSON API, counted for the same connection.
        req.actor = actorOf((req as { auth?: AuthInfo }).auth);
        writeLimit(req, res, next);
        return;
      }
      next();
    },
    (req, res) => void node(req, res, req.body),
  ];
}

/**
 * Answers an error raised on /mcp before the SDK answers (a body that is not JSON or is too
 * large, or the write allowance) as a JSON-RPC error an MCP client can read, never as a page.
 * The HTTP status stays, and `data` carries the same code, hint and retry flag as the API.
 */
export const mcpErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { status, body } = errorBody(err);
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: body.error.message, data: body.error },
    id: null,
  });
};
