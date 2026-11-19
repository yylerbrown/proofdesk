import { Router } from "express";
import type { Config } from "../config.js";
import type { ConnectionService } from "../connections/service.js";
import { llmsText } from "../api/llms-text.js";
import { siteAddress } from "./connections.js";

// One page an AI assistant can read once, with no sign-in. /llms.txt is the usual address for
// such a page and /llms-full.txt the usual one for the full text; this page is short enough to
// be both, so the two answer the same text.

export function llmsRouter(config: Config, connections: ConnectionService | null = null): Router {
  const router = Router();
  router.get(["/llms.txt", "/llms-full.txt"], (req, res) => {
    // The page needs no key. Read with one, it also says what only that connection may do.
    const bearer = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
    const reader = bearer === undefined ? null : (connections?.authenticate(bearer.trim()) ?? null);
    // What a key reads must not be kept by a cache and shown to someone without it.
    if (bearer !== undefined) res.set("Cache-Control", "no-store");
    res.type("text/plain; charset=utf-8").send(llmsText(siteAddress(config, req), reader));
  });
  return router;
}
