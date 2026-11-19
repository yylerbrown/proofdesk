import { describe, expect, it } from "vitest";
import { composeNotice } from "../src/server/notify/compose.js";
import { RESOLVE_REASON_LABELS } from "../src/server/tickets/schemas.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The team's "fixed" reason reads as final: the fix is done, and the customer has not said so.
// It stays short, so the resolve form's choice still fits the ticket's side panel, which
// phone.spec.ts checks in a browser.

const LABEL = "Fixed. Not customer-confirmed.";

describe("the reason for a fix the customer has not confirmed", () => {
  it("is worded as done, apart from Customer confirmed", () => {
    expect(RESOLVE_REASON_LABELS.fixed_no_reply).toBe(LABEL);
  });

  it("shows on the resolved ticket after the team's label", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor).post("/api/tickets/SUP-1/resolve").send({ reason: "fixed_no_reply" });
    const page = (await as(app, customerOne).get("/tickets/SUP-1")).text;
    expect(page).toContain(`Resolved by the team: ${LABEL}`);
  });

  it("ends its sentence once in the email notice", () => {
    const { body } = composeNotice({
      kind: "resolved_by_team",
      ticketKey: "SUP-4",
      title: "Printer jams",
      siteUrl: "https://desk.test",
      recipientName: "Customer One",
      actorName: "Team Member",
      resolvedReason: LABEL,
    });
    expect(body).toContain(
      `Team Member resolved ticket SUP-4, "Printer jams". The reason: ${LABEL}`,
    );
    expect(body).not.toContain("..");
  });
});
