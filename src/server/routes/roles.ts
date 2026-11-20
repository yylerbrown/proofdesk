import { Router } from "express";
import { columnHeaders, rolesTable } from "../roles-table.js";
import { SCOPE_LABELS } from "./connections.js";

// The page "Who may do what": the rules, never any data, so it is open to everyone, signed in
// or not. The table is computed from the same check the server runs on every request.

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
