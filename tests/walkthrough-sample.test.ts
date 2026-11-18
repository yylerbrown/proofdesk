import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// The demo's guided sample fills in only what the visitor is meant to read and change: the
// title, the description and the customer's check. The page address stays empty, so a visitor
// who changes only the title and description never files a made-up address as their own.

describe("the guided sample on the demo", () => {
  it("fills the title, the description and the check, and leaves the page address empty", async () => {
    const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(db, config.ticketPrefix));
    const form = parse(
      (
        await visitor(app)
          .set("Cookie", `${DEV_COOKIE}=demo-customer`)
          .get("/tickets/new?try=1")
          .redirects(1)
      ).text,
    );
    expect(form.querySelector("input[name=title]")?.getAttribute("value")).not.toBe("");
    expect(form.querySelector("textarea[name=description]")?.text).not.toBe("");
    expect(form.querySelector("textarea[name=fix_check]")?.text).not.toBe("");
    expect(form.querySelector("input[name=where_url]")?.getAttribute("value")).toBe("");
  });
});
