import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, refusedBackToTicket, teamActor } from "./helpers.js";

// The Accept and Discard forms name the suggested test they were shown with. A decision made on
// a page opened before a newer suggestion arrived is refused, so it never lands on a test the
// person did not see.

const spec = (summary: string) => ({
  summary,
  scenarios: [
    {
      title: "Ten pages from the tray",
      given: "a full paper tray",
      when: "ten pages are printed in one job",
      then: "all ten come out and none jams",
      test_name: "prints ten pages from the tray",
    },
  ],
});

async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" });
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take");
  await as(built.app, teamActor).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
  return built;
}

describe("deciding on a suggested test", () => {
  it("is refused when the test shown is no longer the current suggestion", async () => {
    const { app, db } = await setup();
    const first = await as(app, teamActor)
      .post("/api/tickets/SUP-1/spec")
      .send(spec("The first suggestion."));
    expect(first.status).toBe(201);
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const forms = page.querySelectorAll(".card-decision form");
    expect(forms).toHaveLength(2);
    for (const form of forms) {
      expect(form.querySelector("input[name=spec_id]")?.getAttribute("value")).toBe(
        String(first.body.id),
      );
    }

    const second = await as(app, teamActor)
      .post("/api/tickets/SUP-1/spec")
      .send(spec("The second suggestion."));
    expect(second.status).toBe(201);
    const service = createTicketService(db, "SUP");
    expect(() =>
      service.decideSpec("SUP-1", { decision: "accept", spec_id: first.body.id }, teamActor),
    ).toThrow(/changed/);
    // A program is told what to do next, and the page sends the person back to the ticket.
    const refused = await as(app, teamActor)
      .post("/api/tickets/SUP-1/spec/decision")
      .send({ decision: "discard", spec_id: first.body.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "spec_changed" });
    expect(refused.body.error.hint).toMatch(/current suggested test/);
    const reason = await refusedBackToTicket(as(app, teamActor), "/tickets/SUP-1/spec/decision", {
      decision: "accept",
      spec_id: String(first.body.id),
    });
    expect(reason).toMatch(/has changed/);
    const current = service.getSpec("SUP-1", teamActor);
    expect(current).toMatchObject({ id: second.body.id, state: "proposed" });

    // The form for the current one still works.
    const accepted = await as(app, teamActor)
      .post("/tickets/SUP-1/spec/decision")
      .type("form")
      .send({ decision: "accept", spec_id: String(second.body.id) });
    expect(accepted.status).toBe(303);
    expect(service.getSpec("SUP-1", teamActor)).toMatchObject({ state: "accepted" });
  });
});
