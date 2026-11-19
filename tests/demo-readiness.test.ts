import { parse } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { errorBody, HttpError } from "../src/server/errors.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// The demo's assistant path: the sample made for assistants is ready for a first run, and a
// demo whose samples were never recorded says it needs a reset instead of going quiet.

function demo({ recorded }: { recorded: boolean }) {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  const service = createTicketService(built.db, built.config.ticketPrefix);
  if (recorded) {
    seedDemo(service);
  } else {
    // What older code left behind: sample tickets with no record of what was seeded.
    service.createTicket({ title: "Cannot sign in", description: "x" }, DEMO_ACTORS[0]!);
  }
  // The seed records the sample's key, so no test names a fixed number for it.
  return { ...built, sample: service.assistantSampleKey() ?? "none" };
}

describe("the sample made for assistants", () => {
  it("is owned by the demo's team member and in progress, so a review request reaches someone", async () => {
    const { app, sample } = demo({ recorded: true });
    const ticket = (
      await visitor(app).set("Cookie", `${DEV_COOKIE}=demo-team`).get(`/api/tickets/${sample}`)
    ).body;
    expect(ticket).toMatchObject({
      title: "Sample for your AI assistant: the total adds tax twice",
      status: "in_progress",
      owner_name: "Demo Team Member",
    });
  });

  it("is the one ticket a new demo connection lists, so a first run just works", async () => {
    const { app, sample } = demo({ recorded: true });
    const page = parse((await visitor(app).post("/demo/connection")).text);
    const key = page.querySelector("input.key")!.getAttribute("value")!;
    const list = await request(app).get("/api/tickets").set("Authorization", `Bearer ${key}`);
    expect(list.body).toEqual([
      expect.objectContaining({ key: sample, owner_name: "Demo Team Member" }),
    ]);
  });
});

describe("a demo whose samples were never recorded", () => {
  it("says it needs a reset in its health answer", async () => {
    const stale = await request(demo({ recorded: false }).app).get("/api/health");
    expect(stale.body.assistant_connections).toBe("needs_reset");
    const ready = await request(demo({ recorded: true }).app).get("/api/health");
    expect(ready.body.assistant_connections).toBe("ready");
    const real = await request(buildTestApp().app).get("/api/health");
    expect(real.body.assistant_connections).toBeUndefined();
  });

  it("says on the welcome page why there is no connection button", async () => {
    const html = parse((await visitor(demo({ recorded: false }).app).get("/sign-in")).text);
    expect(html.querySelector(".notice")?.text).toBe(
      "Assistant connections are off on this demo until its operator resets it.",
    );
    expect(html.querySelector("form[action='/demo/connection']")).toBeNull();
  });

  it("refuses a connection saying only its operator can fix it, and that retrying will not", async () => {
    const res = await visitor(demo({ recorded: false }).app)
      .post("/demo/connection")
      .set("Accept", "application/json");
    expect(res.status).toBe(503);
    expect(res.text).toMatch(/operator resets its database/);
    expect(res.text).not.toMatch(/try again later/i);
  });

  it("tells a program not to retry, with a hint naming the reset", () => {
    const { body } = errorBody(new HttpError(503, "demo_not_ready", "Off until reset."));
    expect(body.error).toMatchObject({ code: "demo_not_ready", retry: false });
    expect(body.error.hint).toMatch(/operator must reset/);
  });
});
