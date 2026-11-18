import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, buildTestApp, visitor } from "./helpers.js";

// The page that shows a new key says in plain words what the key can read.

describe("the page that shows a new key", () => {
  it("says a key reads the tickets handed to it without internal notes, unless given them", async () => {
    const { app } = buildTestApp();
    const plain = parse(
      (
        await admin(app)
          .post("/connections")
          .type("form")
          .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] })
      ).text,
    );
    expect(plain.querySelector(".can-read")?.text).toBe(
      "It can read: the tickets handed to it, without internal notes.",
    );
    const notes = parse(
      (
        await admin(app)
          .post("/connections")
          .type("form")
          .send({ name: "Reader", scopes: ["read_tickets", "read_notes"] })
      ).text,
    );
    expect(notes.querySelector(".can-read")?.text).toBe(
      "It can read: the tickets handed to it, with the team's internal notes.",
    );
  });

  it("on the demo, says only what is true about who sees what the assistant writes", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const html = parse((await visitor(built.app).post("/demo/connection")).text);
    expect(html.querySelector(".can-read")?.text).toBe(
      "It can read: the sample ticket made for assistants, without internal notes.",
    );
    const text = html.querySelector("main")!.text;
    expect(text).toContain(
      "anyone who views as Demo Team Member can see what your assistant wrote",
    );
    expect(text).not.toContain("they never see what it writes");
  });
});
