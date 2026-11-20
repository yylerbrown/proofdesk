import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, FROM_THIS_SITE, visitor } from "./helpers.js";

// On the demo, a switch of person says once, on the next page, who the visitor is now. A team
// member who files a ticket is already on the team's side, so it offers no switch to it.

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const asDemo = (id: string) =>
    visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`).set(FROM_THIS_SITE);
  return { ...built, asDemo };
}

/** Switches the demo's person, then opens the page the switch leads to with its cookies. */
async function switchTo(app: ReturnType<typeof demo>["app"], id: string, next: string) {
  const res = await visitor(app)
    .post("/sign-in/dev")
    .set(FROM_THIS_SITE)
    .type("form")
    .send({ id, next })
    .expect(303);
  expect(res.headers.location).toBe(next);
  const cookies = [res.headers["set-cookie"]].flat().map((c) => String(c).split(";")[0] ?? "");
  const page = await visitor(app).get(next).set("Cookie", cookies.join("; "));
  return { page: parse(page.text), cookies };
}

describe("a switch of person on the demo", () => {
  it("is said once on the next page, by the person's demo name", async () => {
    const { app } = demo();
    const { page, cookies } = await switchTo(app, "demo-team", "/tickets/SUP-3");
    expect(page.querySelector("main > p.saved[role=status]")?.text).toBe(
      "You are now Demo Team Member.",
    );
    // Once: the page after it does not say it again.
    const again = parse(
      (
        await visitor(app)
          .get("/tickets/SUP-3")
          .set("Cookie", cookies.filter((c) => c.startsWith(DEV_COOKIE)).join("; "))
      ).text,
    );
    expect(again.querySelector("main > p.saved")).toBeNull();
  });

  it("names the read-only preview as the header does, and the list after the welcome's link", async () => {
    const { app } = demo();
    const admin = await switchTo(app, "demo-admin", "/tickets");
    expect(admin.page.querySelector("main > p.saved")?.text).toBe(
      "You are now Demo Admin (read-only).",
    );
    const customer = await switchTo(app, "demo-customer", "/tickets");
    expect(customer.page.querySelector("main > p.saved")?.text).toBe("You are now Demo Customer.");
  });
});

describe("a team member's own ticket on the demo", () => {
  it("offers no switch to the team's side, which they are on", async () => {
    const { asDemo } = demo();
    const filed = await asDemo("demo-team")
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x", fix_check: "Ten pages print" })
      .expect(201);
    const html = parse((await asDemo("demo-team").get(`/tickets/${filed.body.key}`)).text);
    expect(html.querySelector(".demo-next")).toBeNull();
    expect(html.querySelector("main")!.text).not.toContain("View this ticket as a team member");
    // A customer's own ticket still offers it.
    const mine = await asDemo("demo-customer")
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x", fix_check: "Ten pages print" })
      .expect(201);
    const theirs = parse((await asDemo("demo-customer").get(`/tickets/${mine.body.key}`)).text);
    expect(theirs.querySelector(".demo-next button")?.text).toBe(
      "View this ticket as a team member",
    );
  });
});
