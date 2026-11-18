import { Router, type Request } from "express";
import { signedIn } from "../actor.js";
import type { Config } from "../config.js";
import { DEFAULT_SCOPES, type ConnectionService } from "../connections/service.js";
import { ValidationError } from "../errors.js";
import { AGENT_SCOPES, CAPABILITIES } from "../permissions.js";

// The admin's page for agent connections: issue one, see its key once, revoke it.

/** Each scope in the words the page uses. */
export const SCOPE_LABELS: Record<(typeof AGENT_SCOPES)[number], string> = {
  read_tickets: "Read tickets, their conversations and internal notes",
  write_notes: "Write internal notes for the team",
  send_replies: "Send replies the customer sees",
  link_changes: "Link a code change to a ticket",
  change_status: "Change the status, never to resolved",
};

/** The site's own address, for the block an admin pastes into an assistant. */
export function siteAddress(config: Config, req: Request): string {
  if (config.signIn !== null) return config.signIn.baseUrl;
  // The host's proxy ends HTTPS in front of a production server.
  const protocol = config.nodeEnv === "production" ? "https" : req.protocol;
  return `${protocol}://${req.get("host")}`;
}

export function connectionsRouter(connections: ConnectionService, config: Config): Router {
  const router = Router();
  // What is never allowed to an agent, read from the capability table.
  const peopleOnly = Object.entries(CAPABILITIES)
    .filter(([, capability]) => capability.agent === "people_only")
    .map(([action]) => action);
  const shared = { scopeLabels: SCOPE_LABELS, scopes: AGENT_SCOPES, peopleOnly };

  function showList(req: Request, res: import("express").Response, status = 200, form = {}) {
    const actor = signedIn(req);
    res.status(status).render("connections", {
      ...shared,
      title: "Agent connections",
      connections: connections.list(actor),
      form: { name: "", scopes: DEFAULT_SCOPES, errors: {}, ...form },
    });
  }

  router.get("/connections", (req, res) => {
    showList(req, res);
  });

  router.post("/connections", (req, res) => {
    const actor = signedIn(req);
    try {
      const { connection, key } = connections.create(req.body, actor);
      res.render("connection-created", {
        title: `Connection ${connection.name}`,
        connection,
        key,
        address: siteAddress(config, req),
        scopeLabels: SCOPE_LABELS,
      });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const scopes = [req.body?.scopes ?? []].flat();
      showList(req, res, 400, { name: req.body?.name ?? "", scopes, errors: err.fieldErrors });
    }
  });

  router.post("/connections/:id/revoke", (req, res) => {
    connections.revoke(Number(req.params.id), signedIn(req));
    res.redirect(303, "/connections");
  });

  return router;
}
