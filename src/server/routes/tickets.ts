import { Router } from "express";
import type { z } from "zod";
import { HttpError } from "../errors.js";
import { changeStatusSchema, createTicketSchema, listQuerySchema } from "../tickets/schemas.js";
import type { TicketService } from "../tickets/service.js";

/** Checks a value against a zod schema, or throws a 400 that lists what is wrong. */
function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ");
    throw new HttpError(400, "validation_error", details);
  }
  return result.data;
}

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
