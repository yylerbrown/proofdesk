import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// While an assistant's suggested test waits for a person's decision, its card is read before the
// step that asks the customer, so nobody is invited to ask before they have reviewed. Once a
// person has decided, the ticket's own card leads again.

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  const service = createTicketService(built.db, built.config.ticketPrefix);
  seedDemo(service);
  const asTeam = () => visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-team`);
  const recorded = service.recordedRunKey() ?? "none";
  return { ...built, asTeam, recorded };
}

const place = (html: string, marker: string) => html.indexOf(marker);

describe("a suggested test waiting for review", () => {
  it("comes before the card that asks the customer, and after it once decided", async () => {
    const { asTeam, recorded } = demo();
    const before = (await asTeam().get(`/tickets/${recorded}`)).text;
    expect(place(before, 'class="assistant-card"')).toBeGreaterThan(-1);
    expect(place(before, 'class="assistant-card"')).toBeLessThan(
      place(before, 'class="ticket-card"'),
    );
    expect(before.match(/class="assistant-card"/g)).toHaveLength(1);

    const decided = await asTeam()
      .post(`/tickets/${recorded}/spec/decision`)
      .type("form")
      .send({ decision: "accept" });
    expect(decided.status).toBeLessThan(400);

    const after = (await asTeam().get(`/tickets/${recorded}`)).text;
    expect(place(after, 'class="ticket-card"')).toBeLessThan(
      place(after, 'class="assistant-card"'),
    );
    expect(after.match(/class="assistant-card"/g)).toHaveLength(1);
  });
});
