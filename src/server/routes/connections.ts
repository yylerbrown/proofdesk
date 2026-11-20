import { Router, type Request } from "express";
import { signedIn } from "../actor.js";
import type { Config } from "../config.js";
import { agentPaste } from "../connections/agent-paste.js";
import {
  DEFAULT_SCOPES,
  SUGGESTION_CHOICES,
  SUGGESTION_SCOPES,
  suggestionChoiceOf,
  type ConnectionService,
} from "../connections/service.js";
import { demoNotReady, HttpError, ValidationError } from "../errors.js";
import { formatTime } from "../pages/format.js";
import { AGENT_SCOPES, can, CAPABILITIES } from "../permissions.js";

// The admin's page for agent connections: issue one, see its key once, revoke it.

/** Each scope in the words the page uses. */
export const SCOPE_LABELS: Record<(typeof AGENT_SCOPES)[number], string> = {
  read_tickets: "Read the tickets handed to it and their conversations, without internal notes",
  read_notes: "Read the team's internal notes on those tickets",
  write_notes: "Write internal notes for the team",
  attach_evidence: "Attach evidence that the check was met",
  propose_specs: "Propose a test spec, which a person accepts or discards",
  link_changes: "Link a code change to a ticket",
  suggest_when_asked: "Suggest ways to verify a ticket when a person asks",
  suggest_automatic: "Suggest ways to verify new tickets without being asked",
};

/** The suggestion setting's three choices in the words the page uses, with what each means. */
export const SUGGESTION_CHOICE_LABELS: Record<
  (typeof SUGGESTION_CHOICES)[number],
  { label: string; hint: string }
> = {
  off: { label: "Off", hint: "It is never asked for ways to verify a ticket." },
  when_asked: {
    label: "When asked",
    hint: "It answers only when a customer presses for suggestions on their new ticket.",
  },
  automatic: {
    label: "Automatic",
    hint: "It also answers the requests a customer's page sends by itself, and suggests on new tickets unasked.",
  },
};

/**
 * The site's own address, for the commands an assistant is given here and at GET /api: the
 * configured public address, else the sign-in address, else the protocol and host the
 * request came to. A server behind a proxy that ends HTTPS sets one of the first two, since
 * the request reaches it over plain http.
 */
export function siteAddress(config: Config, req: Request): string {
  if (config.publicUrl !== undefined) return config.publicUrl;
  if (config.signIn !== null) return config.signIn.baseUrl;
  return `${req.protocol}://${req.get("host")}`;
}

export function connectionsRouter(
  connections: ConnectionService,
  config: Config,
  demoReady: () => boolean,
  /** On the demo, the sample ticket a demo key reads, for the key page's first request. */
  assistantSampleKey: () => string | null = () => null,
): Router {
  const router = Router();
  // What is never allowed to an agent, read from the capability table.
  const peopleOnly = Object.entries(CAPABILITIES)
    .filter(([, capability]) => capability.agent === "people_only")
    .map(([action]) => action);
  const shared = { scopeLabels: SCOPE_LABELS, scopes: AGENT_SCOPES, peopleOnly, formatTime };
  // The issue form ticks the other scopes one by one, and the suggestion setting is one choice.
  const tickedScopes = AGENT_SCOPES.filter((scope) => !SUGGESTION_SCOPES.includes(scope));
  const suggestionChoices = SUGGESTION_CHOICES.map((value) => ({
    value,
    ...SUGGESTION_CHOICE_LABELS[value],
  }));

  function showList(req: Request, res: import("express").Response, status = 200, form = {}) {
    const actor = signedIn(req);
    res.status(status).render("connections", {
      ...shared,
      tickedScopes,
      suggestionChoices,
      title: "Assistant connections",
      connections: connections.list(actor),
      canManage: can(actor, "manage_connections"),
      form: { name: "", scopes: DEFAULT_SCOPES, suggestions: "off", errors: {}, ...form },
    });
  }

  router.get("/connections", (req, res) => {
    showList(req, res);
  });

  router.post("/connections", (req, res) => {
    const actor = signedIn(req);
    try {
      const { connection, key } = connections.create(req.body, actor);
      const address = siteAddress(config, req);
      res.render("connection-created", {
        title: `Connection ${connection.name}`,
        connection,
        key,
        address,
        paste: agentPaste({ address, key, demo: false }),
        formatTime,
      });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const scopes = [req.body?.scopes ?? []].flat();
      const sent: unknown = req.body?.suggestions;
      const suggestions = SUGGESTION_CHOICES.find((choice) => choice === sent);
      showList(req, res, 400, {
        name: req.body?.name ?? "",
        scopes,
        suggestions: suggestions ?? suggestionChoiceOf(scopes),
        errors: err.fieldErrors,
      });
    }
  });

  // The key page is only ever the answer to getting a key: it is shown once. Opening its address
  // again leads back to the welcome page's place for getting another.
  router.get("/demo/connection", (_req, res) => {
    if (!config.demo) throw new HttpError(404, "not_found", "There is no page at this address.");
    res.redirect(303, "/sign-in#connect");
  });

  // On the public demo, any visitor may get their own short-lived connection, from the
  // welcome page, without signing in.
  router.post("/demo/connection", (req, res) => {
    if (!config.demo) throw new HttpError(404, "not_found", "There is no page at this address.");
    if (!demoReady()) throw demoNotReady();
    const { connection, key } = connections.issueDemo();
    // A demo visitor is not signed in, so nothing else stops a cache keeping this key.
    res.set("Cache-Control", "no-store");
    const address = siteAddress(config, req);
    const sampleKey = assistantSampleKey();
    res.render("connection-created", {
      title: "Your demo connection",
      connection,
      key,
      sampleKey,
      address,
      paste: agentPaste({ address, key, demo: true, sampleKey }),
      formatTime,
    });
  });

  // One connection: what it may do and everything it asked for lately, done or refused.
  router.get("/connections/:id", (req, res) => {
    const { connection, activity } = connections.activity(Number(req.params.id), signedIn(req));
    res.render("connection", {
      ...shared,
      title: `Connection ${connection.name}`,
      connection,
      activity,
    });
  });

  router.post("/connections/:id/revoke", (req, res) => {
    connections.revoke(Number(req.params.id), signedIn(req));
    res.redirect(303, "/connections");
  });

  return router;
}
