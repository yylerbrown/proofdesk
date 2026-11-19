import { Router } from "express";
import type { Config } from "../config.js";
import { llmsText } from "../api/llms-text.js";
import { siteAddress } from "./connections.js";

// One page an AI assistant can read once, with no sign-in. /llms.txt is the usual address for
// such a page and /llms-full.txt the usual one for the full text; this page is short enough to
// be both, so the two answer the same text.

export function llmsRouter(config: Config): Router {
  const router = Router();
  router.get(["/llms.txt", "/llms-full.txt"], (req, res) => {
    res.type("text/plain; charset=utf-8").send(llmsText(siteAddress(config, req)));
  });
  return router;
}
