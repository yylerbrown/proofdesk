import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, visitor } from "./helpers.js";

// The demo's admin preview changes nothing. These tests check that it is told so in plain
// words where it would otherwise meet a form, an empty tab or a bare refusal.

function buildDemo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}
const asDemo = (app: Express, id: string) => visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);
const mainText = (html: string) => parse(html).querySelector("main")!.text;

describe("the new-ticket address for the read-only admin preview", () => {
  it("says the preview is read-only and offers no form", async () => {
    const { app } = buildDemo();
    const res = await asDemo(app, "demo-admin").get("/tickets/new");
    expect(res.status).toBe(200);
    const html = parse(res.text);
    expect(html.querySelector(".read-only-note")?.text).toBe(
      "Demo Admin (read-only) changes nothing. Switch to Demo Customer to file a ticket.",
    );
    expect(html.querySelector('form[action="/tickets"]')).toBeNull();
    expect(res.text).not.toContain("File ticket");
  });

  it("still gives the demo customer the form", async () => {
    const { app } = buildDemo();
    const res = await asDemo(app, "demo-customer").get("/tickets/new").redirects(1);
    expect(parse(res.text).querySelector('form[action="/tickets"]')).not.toBeNull();
    expect(res.text).not.toContain("The admin preview is read-only.");
  });
});

describe("the ticket list for the read-only admin preview", () => {
  it("says it is read-only and what an admin does on the real site", async () => {
    const { app } = buildDemo();
    const note = parse((await asDemo(app, "demo-admin").get("/tickets")).text).querySelector(
      ".role-note",
    )!.text;
    expect(note).toBe(
      "Read-only preview. On the real site an admin also restores archived tickets, deletes tickets permanently and manages assistant connections.",
    );
  });

  it.each(["demo-admin", "demo-team"])(
    "gives the demo's reason on the empty Archived tab, as %s",
    async (id) => {
      const { app } = buildDemo();
      const html = parse((await asDemo(app, id).get("/tickets?status=archived")).text);
      expect(html.querySelector(".empty")?.text).toBe(
        "Nothing is archived. Archiving is off on this demo for everyone.",
      );
    },
  );

  it("keeps the plain empty Archived text off the demo", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/tickets?status=archived")).text);
    expect(html.querySelector(".empty")?.text).toBe("Nothing is archived.");
  });
});

describe("a refusal the read-only admin preview meets on an error page", () => {
  it("says the preview is read-only and points to the menu at the top right", async () => {
    const { app } = buildDemo();
    // A form left open from another role, sent after switching to the preview.
    const res = await asDemo(app, "demo-admin")
      .post("/tickets")
      .type("form")
      .send({ title: "Printer is broken", description: "It jams on every page." });
    expect(res.status).toBe(403);
    expect(mainText(res.text)).toContain(
      "The admin preview is read-only. Use the menu at the top right to act as the customer or the team.",
    );
  });

  it("is not added for someone who is not read-only", async () => {
    const { app } = buildTestApp();
    const res = await as(app, customerOne).get("/connections");
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("The admin preview is read-only.");
  });

  it("is not added when the page simply does not exist", async () => {
    const { app } = buildDemo();
    const res = await asDemo(app, "demo-admin").get("/tickets/SUP-9999");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("The admin preview is read-only.");
  });
});
