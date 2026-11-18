import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, refusedBackToTicket, visitor } from "./helpers.js";

// Small things a person meets: where a form's message sits, where a refused action leads, and
// what the sign-in page says to someone already signed in.

describe("a field's message", () => {
  it("comes after the field's label, not inside it, and the field points to it", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/tickets")
      .type("form")
      .send({ title: "x", description: "" });
    const html = parse(res.text);
    for (const name of ["title", "description"]) {
      const label =
        html.querySelector(`label:has([name=${name}])`) ??
        html.querySelectorAll("label").find((l) => l.querySelector(`[name=${name}]`));
      // A hint, such as the title's limits, may sit in the label; the message may not.
      expect(label?.querySelector("small:not(.hint)"), name).toBeNull();
      const field = html.querySelector(`[name=${name}]`);
      const id = field?.getAttribute("aria-describedby")?.split(" ")[0];
      expect(html.querySelector(`#${id}`)?.text, name).toMatch(/^Must /);
    }
  });
});

describe("a refused action on a ticket", () => {
  it("goes back to the ticket and says why there, once", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    const browser = admin(app);
    const reason = await refusedBackToTicket(browser, "/tickets/SUP-1/status", {
      status: "in_progress",
    });
    expect(reason).toBe("Take ticket SUP-1 before moving it to In Progress.");
    const again = await browser.get("/tickets/SUP-1");
    expect(parse(again.text).querySelector(".refused")).toBeNull();
  });

  it("is not followed for a request forged from another site", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    const res = await visitor(app)
      .set("Sec-Fetch-Site", "cross-site")
      .set("Cookie", "dev_actor=dev-admin-1")
      .post("/tickets/SUP-1/take");
    expect(res.status).toBe(403);
  });
});

describe("the sign-in page", () => {
  it("tells someone already signed in, with a way on", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/sign-in")).text);
    expect(html.querySelector(".signed-in")?.text).toContain("You are signed in as Admin");
    expect(html.querySelector(".signed-in a[href='/tickets']")).not.toBeNull();
    expect(parse((await visitor(app).get("/sign-in")).text).querySelector(".signed-in")).toBeNull();
  });
});
