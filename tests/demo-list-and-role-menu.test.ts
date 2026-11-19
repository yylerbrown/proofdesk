import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, buildTestApp, visitor } from "./helpers.js";

// On the demo nobody archives, so the list offers no Archived tab that would always be empty;
// the real site keeps it. The role menu's rows sit close, with no gap that reads as a missing row.

async function demoList(person: string, at = "/tickets") {
  const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(db, config.ticketPrefix));
  return parse((await visitor(app).set("Cookie", `${DEV_COOKIE}=${person}`).get(at)).text);
}

const tabs = (html: ReturnType<typeof parse>) =>
  html
    .querySelectorAll('nav[aria-label="Filter by status"] a')
    .map((a) => a.childNodes[0]!.text.trim());

describe("the Archived tab", () => {
  it("is not offered on the demo, where nothing can be archived", async () => {
    for (const person of ["demo-team", "demo-admin"]) {
      expect(tabs(await demoList(person))).toEqual(["All", "New", "In Progress", "Resolved"]);
    }
  });

  it("still answers its address on the demo, saying why it is empty", async () => {
    const html = await demoList("demo-team", "/tickets?status=archived");
    expect(html.querySelector(".empty")?.text).toBe(
      "Nothing is archived. Archiving is off on this demo for everyone.",
    );
  });

  it("is offered on the real site", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/tickets")).text);
    expect(tabs(html)).toContain("Archived");
  });
});

describe("the role menu", () => {
  it("has no gap between its rows", () => {
    const css = fs.readFileSync("public/site.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const found = /\.site-header details\.dropdown\.person-menu > summary \+ ul \{([^}]*)\}/.exec(
      css,
    );
    expect(found?.[1]).toContain("gap: 0;");
  });
});
