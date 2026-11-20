import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  resolveTicket,
  teamActor,
  visitor,
} from "./helpers.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";

// "Edit" and the filer's "Archive" are quiet links at the end of the line under the title. Edit
// shows only where editing is allowed. The filer's Archive shows there only while the ticket is
// not resolved, and the archive page tells them what it is for.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages",
};

async function filed() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  return built;
}

const page = async (app: Express, who = teamActor, at = "/tickets/SUP-1") =>
  parse((await as(app, who).get(at)).text);

const lineLinks = (html: ReturnType<typeof parse>) =>
  html.querySelectorAll("a.ticket-line-link").map((a) => a.text);

describe("Edit on the line under the title", () => {
  it("is not offered in the read-only preview, which may change nothing", async () => {
    const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(db, config.ticketPrefix));
    const html = parse(
      (await visitor(app).set("Cookie", `${DEV_COOKIE}=demo-admin`).get("/tickets/SUP-1")).text,
    );
    expect(html.querySelector(".ticket-page")).not.toBeNull();
    expect(lineLinks(html)).toEqual([]);
    expect(html.querySelector("a[href$='/edit']")).toBeNull();
  });

  it("is not offered on an archived ticket", async () => {
    const { app } = await filed();
    expect((await admin(app).post("/tickets/SUP-1/archive")).status).toBe(303);
    const html = await page(app, adminActor);
    expect(html.querySelector(".ticket-page")).not.toBeNull();
    expect(lineLinks(html)).toEqual([]);
  });
});

describe("the filer's Archive", () => {
  it("leaves the line once the ticket is resolved, and waits under More options", async () => {
    const { app } = await filed();
    await resolveTicket(app, "SUP-1", customerOne);
    const html = await page(app, customerOne);
    expect(html.querySelector(".ticket-page")?.getAttribute("data-ticket-status")).toBe("resolved");
    expect(lineLinks(html)).toEqual(["Edit"]);
    const more = html.querySelector("details.more-options")!;
    expect(more.querySelector("a[href$='/archive']")?.text).toBe("Archive ticket");
  });

  it("leads to a page that says what archiving is for, and only the filer reads it", async () => {
    const { app } = await filed();
    const mine = parse((await as(app, customerOne).get("/tickets/SUP-1/archive")).text);
    expect(mine.querySelector("p.archive-why")?.text).toBe(
      "Filed by mistake, or twice? Archiving takes this ticket off your list and the team's.",
    );
    const team = parse((await as(app, teamActor).get("/tickets/SUP-1/archive")).text);
    expect(team.querySelector("p.archive-why")).toBeNull();
  });
});
