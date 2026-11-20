import fs from "node:fs";
import type http from "node:http";
import type { Express } from "express";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { loadConfig } from "../src/server/config.js";
import { DEMO_BUDGET, seedDemo } from "../src/server/demo.js";
import { createDemoReset } from "../src/server/demo-reset.js";
import { SHOWN_ONLY_TO_UPLOADER } from "../src/server/pictures/limits.js";
import { samplePicture } from "../src/server/pictures/sample.js";
import { openSite } from "../src/server/start.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, FROM_THIS_SITE } from "./helpers.js";

// The shared public demo must never become a place to host pictures for strangers. A visitor's
// picture is served only to the browser that added it; everyone else is told it is there and
// gets no bytes. The demo's own sample picture is shown to everyone who can open its ticket, and
// its caps are smaller.

const [demoCustomer, demoTeam] = DEMO_ACTORS as [
  (typeof DEMO_ACTORS)[number],
  (typeof DEMO_ACTORS)[number],
];
const PNG = samplePicture();

function buildDemo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  const service = createTicketService(built.db, built.config.ticketPrefix, DEMO_BUDGET);
  seedDemo(service);
  return { ...built, service };
}

/** A browser on the demo as this demo person, holding these extra cookies. */
function browser(app: Express | http.RequestListener, who: string, cookies: string[] = []) {
  const cookie = [`${DEV_COOKIE}=${who}`, ...cookies].join("; ");
  return {
    get: (address: string) => request(app).get(address).set(FROM_THIS_SITE).set("Cookie", cookie),
    post: (address: string) => request(app).post(address).set(FROM_THIS_SITE).set("Cookie", cookie),
  };
}

/** The demo customer's own sample ticket that a visitor can reply on. */
function customersTicket(service: ReturnType<typeof buildDemo>["service"]): string {
  const own = service.listTickets("all", demoCustomer, 1);
  const found = own.find((ticket) => ticket.title === "Invoice shows the wrong date");
  if (found === undefined) throw new Error("No sample for the demo customer");
  return found.key;
}

/** The token cookie a response set, as "name=value". */
function tokenCookie(setCookie: string | string[] | undefined): string {
  const lines = [setCookie ?? []].flat();
  const line = lines.find((one) => one.startsWith("demo_pictures="));
  if (line === undefined) throw new Error("No picture token was set");
  return line.split(";")[0]!;
}

describe("the demo's sample picture", () => {
  it("is on the dark-mode sample, and shown to every browser that can open that ticket", async () => {
    const { app, service, db } = buildDemo();
    const sample = service
      .listTickets("all", demoTeam, 1)
      .find((ticket) => ticket.title === "Settings page text is hard to read in dark mode")!;
    const [picture] = service.listPictures(sample.key, demoTeam, null).description;
    expect(picture).toMatchObject({ type: "image/png", hidden: null });
    const loaded = await browser(app, demoTeam.id).get(picture!.url!);
    expect(loaded.status).toBe(200);
    expect(loaded.headers["content-type"]).toBe("image/png");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM ticket_pictures").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("a visitor's picture on the demo", () => {
  it("is served only to the browser that added it", async () => {
    const { app, service } = buildDemo();
    const key = customersTicket(service);
    const sent = await browser(app, demoCustomer.id)
      .post(`/tickets/${key}/entries`)
      .field("kind", "reply")
      .field("body", "This is what I see.")
      .attach("pictures", PNG, "mine.png");
    expect(sent.status).toBe(303);
    const cookieLine = [sent.headers["set-cookie"] ?? []]
      .flat()
      .find((line: string) => line.startsWith("demo_pictures="))!;
    expect(cookieLine).toMatch(/HttpOnly/);
    const token = tokenCookie(sent.headers["set-cookie"]);

    // The browser that added it: listed with its address, and its bytes load.
    const own = service.listPictures(key, demoCustomer, token.split("=")[1]!);
    const [picture] = [...own.byEntry.values()].flat();
    expect(picture).toMatchObject({ hidden: null });
    expect(picture!.url).not.toBeNull();
    expect((await browser(app, demoCustomer.id, [token]).get(picture!.url!)).status).toBe(200);

    // Another visitor, even as the same demo person, and the demo team: told, never sent.
    const address = `/tickets/${key}/pictures/${picture!.id}`;
    for (const who of [demoCustomer.id, demoTeam.id]) {
      const other = await browser(app, who).get(address);
      expect(other.status).toBe(404);
      expect(other.headers["content-type"]).not.toContain("image");
    }
    const elsewhere = [...service.listPictures(key, demoTeam, null).byEntry.values()].flat();
    expect(elsewhere).toEqual([
      expect.objectContaining({ id: picture!.id, url: null, hidden: SHOWN_ONLY_TO_UPLOADER }),
    ]);
    // A made-up token does not open it either.
    const guessed = `demo_pictures=${"A".repeat(43)}`;
    expect((await browser(app, demoTeam.id, [guessed]).get(address)).status).toBe(404);
  });

  it("keeps the same browser's token for its next picture", async () => {
    const { app, service } = buildDemo();
    const key = customersTicket(service);
    const first = await browser(app, demoCustomer.id)
      .post(`/tickets/${key}/entries`)
      .field("kind", "reply")
      .field("body", "One")
      .attach("pictures", PNG, "one.png");
    const token = tokenCookie(first.headers["set-cookie"]);
    const second = await browser(app, demoCustomer.id, [token])
      .post(`/tickets/${key}/entries`)
      .field("kind", "reply")
      .field("body", "Two")
      .attach("pictures", PNG, "two.png");
    expect(second.headers["set-cookie"] ?? []).not.toContainEqual(
      expect.stringContaining("demo_pictures="),
    );
    const mine = [
      ...service.listPictures(key, demoCustomer, token.split("=")[1]!).byEntry.values(),
    ];
    expect(mine.flat().map((p) => p.hidden)).toEqual([null, null]);
  });

  it("is refused over 1 MB, and more than 2 at a time", async () => {
    const { app, service, db } = buildDemo();
    const key = customersTicket(service);
    // Larger than a real site's limit too, so only the demo's own parser limit names 1 MB.
    const big = Buffer.concat([PNG, Buffer.alloc(3.5 * 1024 * 1024)]);
    const tooBig = await browser(app, demoCustomer.id)
      .post(`/tickets/${key}/entries`)
      .field("kind", "reply")
      .field("body", "Big")
      .attach("pictures", big, "big.png");
    expect(tooBig.status).toBe(400);
    expect(tooBig.text).toContain("Each picture must be at most 1 MB.");
    let three = browser(app, demoCustomer.id)
      .post(`/tickets/${key}/entries`)
      .field("kind", "reply")
      .field("body", "Three");
    for (const name of ["a.png", "b.png", "c.png"]) three = three.attach("pictures", PNG, name);
    const refused = await three;
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("Attach at most 2 pictures at a time.");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM ticket_pictures").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("is refused once visitors have added 40 until the next reset", async () => {
    const { app, service } = buildDemo();
    const two = { files: [PNG, PNG], refused: null };
    // Twenty messages of two pictures each, on two of the team's samples, from other browsers.
    // Not the customer's own sample, which gets the one picture too many below.
    const own = customersTicket(service);
    const keys = service
      .listTickets("all", demoTeam, 1)
      .filter((ticket) => !ticket.title.includes("dark mode") && ticket.key !== own)
      .slice(0, 2)
      .map((ticket) => ticket.key);
    for (const key of keys) {
      for (let message = 0; message < 10; message += 1) {
        service.addEntryWithPictures(
          key,
          { kind: "note", body: "Seen" },
          two,
          demoTeam,
          `other-${key}-${message}`,
        );
      }
    }
    const key = customersTicket(service);
    const over = await browser(app, demoCustomer.id)
      .post(`/tickets/${key}/entries`)
      .field("kind", "reply")
      .field("body", "One more")
      .attach("pictures", PNG, "one.png");
    expect(over.status).toBe(400);
    expect(over.text).toContain(
      "This shared demo holds at most 40 visitors&#39; pictures until it next resets.",
    );
  });
});

describe("the demo going back to its samples", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  it("clears visitors' pictures and keeps only its own sample", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-pictures-"));
    folders.push(folder);
    const config = loadConfig({
      DEMO: "on",
      DEV_SIGN_IN: "off",
      DATABASE_PATH: `${folder}/app.db`,
    });
    const clock = { now: Date.now() };
    const reset = createDemoReset({
      config,
      log: () => {},
      site: openSite(config, () => {}),
      now: () => clock.now,
    });
    const count = () =>
      (
        reset.current().db.prepare("SELECT COUNT(*) AS n FROM ticket_pictures").get() as {
          n: number;
        }
      ).n;
    const listed = await browser(reset.handler, demoCustomer.id).get("/api/tickets");
    const key = (listed.body as { key: string; title: string }[]).find(
      (ticket) => ticket.title === "Invoice shows the wrong date",
    )!.key;
    const sent = await browser(reset.handler, demoCustomer.id)
      .post(`/tickets/${key}/entries`)
      .field("kind", "reply")
      .field("body", "A visitor's picture")
      .attach("pictures", PNG, "mine.png");
    expect(sent.status).toBe(303);
    expect(count()).toBe(2);
    clock.now += 3 * 60 * 60 * 1000;
    expect(reset.check()).toBe(true);
    expect(count()).toBe(1);
    reset.current().db.close();
  });
});
