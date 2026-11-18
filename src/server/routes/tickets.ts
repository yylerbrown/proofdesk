import { Router } from "express";
import { signedIn } from "../actor.js";
import { listQuerySchema } from "../tickets/schemas.js";
import type { TicketService } from "../tickets/service.js";
import { parse } from "../validation.js";

// Routes only read the request, call the service and send the answer. The service checks
// the ticket rules and the permissions itself. signedIn(req) answers 401 when nobody is
// signed in.
export function ticketsRouter(service: TicketService): Router {
  const router = Router();

  router.post("/tickets", (req, res) => {
    res.status(201).json(service.createTicket(req.body, signedIn(req)));
  });

  router.get("/tickets", (req, res) => {
    const { status, page } = parse(listQuerySchema, req.query);
    res.json(service.listTickets(status ?? "all", signedIn(req), page ?? 1));
  });

  router.get("/tickets/:key", (req, res) => {
    res.json(service.getTicket(req.params.key, signedIn(req)));
  });

  router.patch("/tickets/:key", (req, res) => {
    res.json(service.changeStatus(req.params.key, req.body, signedIn(req)));
  });

  // PUT replaces the text of the ticket. PATCH above changes only the status.
  router.put("/tickets/:key", (req, res) => {
    res.json(service.editTicket(req.params.key, req.body, signedIn(req)));
  });

  // Sets the agreed version of the check: { "agreed_check": "..." }. Empty removes it.
  router.put("/tickets/:key/agreed-check", (req, res) => {
    res.json(service.agreeCheck(req.params.key, req.body, signedIn(req)));
  });

  // From merged to confirmed: { "change_url" }, then { "try_url" }, then the customer's
  // { "fixed": "yes" } or { "fixed": "no", "comment": "..." }.
  router.put("/tickets/:key/change-link", (req, res) => {
    res.json(service.linkChange(req.params.key, req.body, signedIn(req)));
  });

  router.post("/tickets/:key/ready", (req, res) => {
    res.json(service.markReady(req.params.key, req.body, signedIn(req)));
  });

  router.post("/tickets/:key/answer", (req, res) => {
    res.json(service.answer(req.params.key, req.body, signedIn(req)));
  });

  router.post("/tickets/:key/take", (req, res) => {
    res.json(service.takeTicket(req.params.key, signedIn(req)));
  });

  router.post("/tickets/:key/release", (req, res) => {
    res.json(service.releaseTicket(req.params.key, signedIn(req)));
  });

  router.post("/tickets/:key/archive", (req, res) => {
    res.json(service.archiveTicket(req.params.key, signedIn(req)));
  });

  router.post("/tickets/:key/restore", (req, res) => {
    res.json(service.restoreTicket(req.params.key, signedIn(req)));
  });

  // Permanent deletion. The body must repeat the key: { "confirm": "SUP-42" }. The answer
  // says whether the old text has also left the files on disk.
  router.delete("/tickets/:key", (req, res) => {
    const { filesCleaned } = service.deleteTicket(req.params.key, req.body, signedIn(req));
    res.json({ deleted: true, files_cleaned: filesCleaned });
  });

  router.get("/tickets/:key/entries", (req, res) => {
    res.json(service.listEntries(req.params.key, signedIn(req)));
  });

  // Adds a reply or an internal note: { "kind": "reply", "body": "..." }.
  router.post("/tickets/:key/entries", (req, res) => {
    res.status(201).json(service.addEntry(req.params.key, req.body, signedIn(req)));
  });

  router.get("/tickets/:key/events", (req, res) => {
    res.json(service.listEvents(req.params.key, signedIn(req)));
  });

  return router;
}
