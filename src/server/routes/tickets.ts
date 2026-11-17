import { Router } from "express";
import { changeStatusSchema, createTicketSchema, listQuerySchema } from "../tickets/schemas.js";
import type { TicketService } from "../tickets/service.js";
import { parse } from "../validation.js";

// Routes only read the request, call the service and send the answer.
export function ticketsRouter(service: TicketService): Router {
  const router = Router();

  router.post("/tickets", (req, res) => {
    const input = parse(createTicketSchema, req.body);
    res.status(201).json(service.createTicket(input, req.actor));
  });

  router.get("/tickets", (req, res) => {
    const { status } = parse(listQuerySchema, req.query);
    res.json(service.listTickets(status ?? "all"));
  });

  router.get("/tickets/:key", (req, res) => {
    res.json(service.getTicket(req.params.key));
  });

  router.patch("/tickets/:key", (req, res) => {
    const { status } = parse(changeStatusSchema, req.body);
    res.json(service.changeStatus(req.params.key, status, req.actor));
  });

  router.get("/tickets/:key/events", (req, res) => {
    res.json(service.listEvents(req.params.key));
  });

  return router;
}
