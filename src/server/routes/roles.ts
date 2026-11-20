import { Router } from "express";
import { columnHeaders, rolesTable } from "../roles-table.js";
import { SCOPE_LABELS } from "./connections.js";

// The page "Who may do what": the rules, never any data, so it is open to everyone, signed in
// or not. The table starts from the server's own permission check and adds who must own the
// ticket.

export function rolesRouter(): Router {
  const router = Router();
  router.get("/roles", (req, res) => {
    res.render("roles", {
      title: "Who may do what",
      groups: rolesTable(SCOPE_LABELS),
      headers: columnHeaders(req.actor),
    });
  });
  return router;
}
