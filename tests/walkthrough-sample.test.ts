import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// The demo's guided sample fills in only what the visitor is meant to read and change: the
// title and the description. What would prove it is fixed is the step after filing. The page
// address stays empty, so a visitor who changes only the title and description never files a
// made-up address as their own.

describe("the guided sample on the demo", () => {
  it("fills the title and the description, and sends no check and no page address", async () => {
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
    expect(form.querySelector("[name=fix_check]")).toBeNull();
    expect(form.querySelector("input[name=where_url]")).toBeNull();
  });
});

describe("the line above the guided sample", () => {
  async function newForm(address: string) {
    const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(db, config.ticketPrefix));
    return parse(
      (await visitor(app).set("Cookie", `${DEV_COOKIE}=demo-customer`).get(address).redirects(1))
        .text,
    );
  }

  it("says the boxes hold a sample that can be filed as it is or changed", async () => {
    const form = await newForm("/tickets/new?try=1");
    expect(form.querySelector(".sample-note")?.text.trim()).toBe(
      "These boxes hold a sample. File it as it is, or change it first.",
    );
  });

  it("is not shown on an empty form", async () => {
    const form = await newForm("/tickets/new");
    expect(form.querySelector(".sample-note")).toBeNull();
  });
});
