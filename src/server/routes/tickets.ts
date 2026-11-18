import { Router } from "express";
import { listQuerySchema } from "../tickets/schemas.js";
import type { TicketService } from "../tickets/service.js";
import { parse } from "../validation.js";

// Routes only read the request, call the service and send the answer. The service checks
// the ticket rules itself, so a request body is handed to it as it arrived.
export function ticketsRouter(service: TicketService): Router {
  const router = Router();

  router.post("/tickets", (req, res) => {
    res.status(201).json(service.createTicket(req.body, req.actor));
  });

  router.get("/tickets", (req, res) => {
    const { status } = parse(listQuerySchema, req.query);
    res.json(service.listTickets(status ?? "all"));
  });

  router.get("/tickets/:key", (req, res) => {
    res.json(service.getTicket(req.params.key));
  });

  router.patch("/tickets/:key", (req, res) => {
    res.json(service.changeStatus(req.params.key, req.body, req.actor));
  });

  // PUT replaces the text of the ticket. PATCH above changes only the status.
  router.put("/tickets/:key", (req, res) => {
    res.json(service.editTicket(req.params.key, req.body, req.actor));
  });

  router.post("/tickets/:key/archive", (req, res) => {
    res.json(service.archiveTicket(req.params.key, req.actor));
  });

  router.post("/tickets/:key/restore", (req, res) => {
    res.json(service.restoreTicket(req.params.key, req.actor));
  });

  router.get("/tickets/:key/events", (req, res) => {
    res.json(service.listEvents(req.params.key));
  });

  return router;
}
