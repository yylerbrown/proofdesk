import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE, landsInDemo } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, SIGN_IN_ENV, visitor } from "./helpers.js";

// A first-time visitor to the demo opens straight into the product as the demo customer, on
// the ticket list. Only on the demo, only for opening the list, and never in place of a sign-in
// the visitor already has.

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}

const cookies = (res: { headers: Record<string, unknown> }) =>
  ((res.headers["set-cookie"] as string[] | undefined) ?? []).join(";");

describe("the demo's first landing", () => {
  it("opens the list as the demo customer, with the demo's sign-in cookie", async () => {
    const { app } = demo();
    const res = await visitor(app).get("/tickets");
    expect(res.status).toBe(200);
    expect(cookies(res)).toMatch(
      new RegExp(`${DEV_COOKIE}=demo-customer;.*HttpOnly.*SameSite=Lax`),
    );
    expect(parse(res.text).querySelector("header .viewer strong")?.text).toBe("Demo Customer");
  });

  it("keeps a sign-in the visitor already has", async () => {
    const { app } = demo();
    const res = await visitor(app).get("/tickets").set("Cookie", `${DEV_COOKIE}=demo-team`);
    expect(cookies(res)).not.toContain(DEV_COOKIE);
    expect(parse(res.text).querySelector("header .viewer strong")?.text).toBe("Demo Team Member");
  });

  it("never acts for a request that changes something", async () => {
    const { app, db } = demo();
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
    const before = count();
    const res = await visitor(app)
      .post("/tickets")
      .type("form")
      .send({ title: "Printer jams", description: "Every time." });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/sign-in");
    expect(cookies(res)).not.toContain(DEV_COOKIE);
    expect(count()).toBe(before);
  });

  it("is not for the API, which still asks for a sign-in", async () => {
    const { app } = demo();
    const res = await visitor(app).get("/api/tickets");
    expect(res.status).toBe(401);
    expect(cookies(res)).not.toContain(DEV_COOKIE);
  });

  it("sends a visitor to any other page through the page about the demo, keeping the address", async () => {
    const { app } = demo();
    const res = await visitor(app).get("/tickets/SUP-8");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/sign-in?next=%2Ftickets%2FSUP-8");
    expect(cookies(res)).not.toContain(DEV_COOKIE);
  });

  it("never happens on the real site or the development entrance", async () => {
    for (const env of [SIGN_IN_ENV, {}]) {
      const { app } = buildTestApp(env);
      const res = await visitor(app).get("/tickets");
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe("/sign-in?next=%2Ftickets");
      expect(cookies(res)).not.toContain(DEV_COOKIE);
    }
  });

  it("counts only opening the list or the home page", () => {
    const { config } = demo();
    expect(landsInDemo(config, "GET", "/tickets")).toBe(true);
    expect(landsInDemo(config, "GET", "/")).toBe(true);
    expect(landsInDemo(config, "HEAD", "/tickets")).toBe(true);
    expect(landsInDemo(config, "POST", "/tickets")).toBe(false);
    expect(landsInDemo(config, "GET", "/api/tickets")).toBe(false);
    expect(landsInDemo(config, "GET", "/tickets/SUP-1")).toBe(false);
    expect(landsInDemo(config, "GET", "/sign-in")).toBe(false);
    expect(landsInDemo(buildTestApp().config, "GET", "/tickets")).toBe(false);
  });
});

describe("the demo's footer", () => {
  it("links every demo page but the About page itself to it, quietly", async () => {
    const { app } = demo();
    const browser = visitor(app).set("Cookie", `${DEV_COOKIE}=demo-team`);
    for (const address of ["/tickets", "/tickets/SUP-1", "/tickets/new"]) {
      const html = parse((await browser.get(address).redirects(1)).text);
      const link = html.querySelector("footer.site-footer a");
      expect(link?.getAttribute("href"), address).toBe("/sign-in");
      expect(link?.text).toBe("About this demo");
    }
    const about = parse((await browser.get("/sign-in")).text);
    expect(about.querySelector("footer.site-footer")).toBeNull();
  });

  it("is not on the real site or the development entrance", async () => {
    for (const env of [SIGN_IN_ENV, {}]) {
      const { app } = buildTestApp(env);
      const html = parse((await visitor(app).get("/sign-in")).text);
      expect(html.querySelector("footer.site-footer")).toBeNull();
    }
  });
});
