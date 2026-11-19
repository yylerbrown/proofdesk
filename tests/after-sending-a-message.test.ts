import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE, type Actor } from "../src/server/actor.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// After a reply or an internal note, the page opens at the line that says it was sent, which
// sits under the conversation by the message box, and the "Who sees it" choice stays on what
// was just sent for that page load. A later visit starts on a reply again.

async function setup() {
  const { app } = buildTestApp();
  await as(app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "It jams on page two." });
  return app;
}

/** Sends a message from the ticket page's form, then opens the page it is sent back to. */
async function send(app: Express, who: Actor, kind: "reply" | "note") {
  const sent = await as(app, who)
    .post("/tickets/SUP-1/entries")
    .type("form")
    .send({ kind, body: `A ${kind} from the form.` });
  // The one cookie that says what was saved, as the browser would send it back.
  const saved = [sent.headers["set-cookie"]].flat().find((c) => c?.startsWith("saved="))!;
  const page = await as(app, who)
    .set("Cookie", `${DEV_COOKIE}=${who.id}; ${saved.split(";")[0]}`)
    .get("/tickets/SUP-1");
  return { location: sent.headers.location, html: parse(page.text) };
}

const chosen = (html: ReturnType<typeof parse>) =>
  html.querySelector('input[name="kind"][checked]')?.getAttribute("value");

describe("after an internal note", () => {
  it("keeps the choice on Internal note and shows the sent line by the message box", async () => {
    const app = await setup();
    const { location, html } = await send(app, teamActor, "note");
    expect(location).toBe("/tickets/SUP-1#sent");
    expect(chosen(html)).toBe("note");
    const line = html.querySelector('.ticket-thread p#sent[role="status"]');
    expect(line?.text).toBe("Internal note added. The customer does not see it.");
    // The line comes after the conversation, so the note it names is just above it.
    expect(html.querySelector("main > p.saved")).toBeNull();
  });

  it("starts on a reply again on the next visit", async () => {
    const app = await setup();
    await send(app, teamActor, "note");
    const later = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(chosen(later)).toBe("reply");
    expect(later.querySelector("p#sent")).toBeNull();
  });
});

describe("after a reply", () => {
  it("keeps the choice on reply", async () => {
    const app = await setup();
    const { html } = await send(app, teamActor, "reply");
    expect(chosen(html)).toBe("reply");
    expect(html.querySelector("p#sent")?.text).toBe("Reply sent.");
  });

  it("shows the customer the sent line by their message box", async () => {
    const app = await setup();
    const { html } = await send(app, customerOne, "reply");
    expect(html.querySelector("p#sent")?.text).toBe("Reply sent.");
  });
});
