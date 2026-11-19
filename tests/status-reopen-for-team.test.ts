import { parse } from "node-html-parser";
import { describe, expect, it, vi } from "vitest";
import { as, admin, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The ticket page shows Reopen from the allowed actions, never from the viewer's role. The
// real rule lets only the customer, the owner or an admin reopen. This file lets every team
// member reopen, and checks that the page then offers the team a Reopen that works.

vi.mock("../src/server/permissions.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/permissions.js")>();
  return {
    ...real,
    can: (...args: Parameters<typeof real.can>) => {
      const [actor, action] = args;
      if (action === "reopen" && actor.role === "team" && actor.readOnly !== true) return true;
      return real.can(...args);
    },
  };
});

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

async function resolvedByTheTeam() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  await as(built.app, teamActor)
    .post("/api/tickets/SUP-1/resolve")
    .send({ reason: "wont_fix" })
    .expect(200);
  return built;
}

describe("Reopen for whoever the rules allow", () => {
  it("opens the team's reopen from In Progress in the Status menu, and it reopens the ticket", async () => {
    const { app } = await resolvedByTheTeam();
    const html = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const link = html.querySelector(".status-menu a[href$='?step=reopen#reopen-form']")!;
    expect(link.text).toBe("In Progress");
    const shown = parse((await as(app, teamActor).get("/tickets/SUP-1?step=reopen")).text);
    const reopen = shown.querySelector(".ticket-card form#reopen-form")!;
    expect(reopen.getAttribute("action")).toBe("/tickets/SUP-1/reopen");
    expect(reopen.querySelector("button")?.text).toBe("Reopen ticket");
    expect(reopen.querySelector("a")?.text).toBe("Cancel");
    // While it shows, it holds the page's one filled button, in place of the next step.
    expect(shown.querySelector(".next-action")).toBeNull();
    // The customer's own "Still happening?" stays theirs, and the plain page shows no form.
    expect(html.querySelector("#reopen")).toBeNull();
    expect(html.querySelector("form#reopen-form")).toBeNull();

    const done = await as(app, teamActor)
      .post("/tickets/SUP-1/reopen")
      .type("form")
      .send({ reason: "The fix was rolled back." });
    expect(done.status).toBe(303);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
  });

  it("keeps the form open with the message when the reason is missing", async () => {
    const { app } = await resolvedByTheTeam();
    const refused = await as(app, teamActor)
      .post("/tickets/SUP-1/reopen")
      .type("form")
      .send({ reason: "" });
    expect(refused.status).toBe(400);
    const html = parse(refused.text);
    const reopen = html.querySelector("form#reopen-form")!;
    expect(reopen.querySelector("#reopen-error")?.text).toMatch(/reason for reopening/);
    expect(reopen.querySelector("textarea")?.getAttribute("aria-describedby")).toBe("reopen-error");
  });

  it("still gives the customer only their own way to reopen", async () => {
    const { app } = await resolvedByTheTeam();
    const html = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(html.querySelector("#reopen summary")?.text).toBe("Still happening?");
    expect(html.querySelector("form#reopen-form")).toBeNull();
  });
});
