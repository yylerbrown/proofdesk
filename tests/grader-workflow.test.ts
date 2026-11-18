import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  FROM_THIS_SITE,
  teamActor,
  visitor,
} from "./helpers.js";

// From a cold walk by a first-time visitor: titles lead to their tickets, the team reads plainly
// who resolves, and after taking a ticket the owner asks the customer in one press, on the demo
// as on the real site, with nothing to invent first.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const asDemo = (id: string) => visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`);
  return { ...built, asDemo };
}

/** On the demo, the team member takes a new sample and starts work on it. */
async function demoInProgress() {
  const built = demo();
  await built.asDemo("demo-team").post("/tickets/SUP-2/take-and-start").set(FROM_THIS_SITE);
  return built;
}

describe("the ticket list", () => {
  it("lets a long title wrap to two lines on a wide screen instead of cutting it off", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    const wide = css.slice(css.indexOf("@media (min-width: 640px)"));
    const cell = /table\.tickets td\.user-text \{([^}]*)\}/.exec(wide)![1]!;
    expect(cell).not.toMatch(/nowrap|ellipsis/);
    expect(wide).toMatch(/table\.tickets td\.user-text a \{[^}]*-webkit-line-clamp: 2/);
  });

  it("offers a description box short enough that File ticket shows on a laptop screen", async () => {
    const { app } = buildTestApp();
    const form = parse((await as(app, customerOne).get("/tickets/new").redirects(1)).text);
    expect(form.querySelector("textarea[name=description]")?.getAttribute("rows")).toBe("3");
  });

  it("links each title to its ticket, as well as its key", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = parse((await as(app, teamActor).get("/tickets")).text);
    const link = html.querySelector("table.tickets td.title-cell a");
    expect(link?.text).toBe("Printer jams");
    expect(link?.getAttribute("href")).toBe("/tickets/SUP-1");
  });
});

describe("who resolves", () => {
  it("is said exactly where the team looks for Resolved: the status and the edit page", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const sentence =
      "The customer confirms a fix with Yes; the team can also resolve with a reason.";
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    // On the ticket, Resolve sits under the status for those who may; the line says the way on.
    expect(page.querySelector(".status-rule")?.text).toBe(
      "Start work, then ask the customer to verify.",
    );
    const edit = parse((await as(app, teamActor).get("/tickets/SUP-1/edit")).text);
    expect(edit.querySelector(".status-rule")?.text).toBe(sentence);
    // The customer who filed it is not told they cannot.
    const own = parse((await as(app, customerOne).get("/tickets/SUP-1/edit")).text);
    expect(own.querySelector(".status-rule")).toBeNull();
  });
});

describe("the demo's ask", () => {
  it("is one press after taking the ticket, with no sample values to fill in", async () => {
    const { asDemo } = await demoInProgress();
    const page = parse((await asDemo("demo-team").get("/tickets/SUP-2")).text);
    const next = page.querySelector(".next-action form")!;
    expect(next.getAttribute("action")).toBe("/tickets/SUP-2/ready");
    expect(next.querySelector("button")?.text).toBe("Ask the customer to verify");
    expect(page.text).not.toContain("Demo sample value");
    expect(page.querySelector("form[action$='/sample-fix']")).toBeNull();

    const asked = await asDemo("demo-team").post("/tickets/SUP-2/ready").set(FROM_THIS_SITE);
    expect([asked.status, asked.headers.location]).toEqual([303, "/tickets/SUP-2"]);
    const customer = parse((await asDemo("demo-customer").get("/tickets/SUP-2")).text);
    expect(customer.querySelector("#did-this-fix-it h2")?.text).toBe("Did this fix it?");
  });

  it("has no sample fix address any more", async () => {
    const { asDemo } = await demoInProgress();
    const old = await asDemo("demo-team").post("/tickets/SUP-2/sample-fix").set(FROM_THIS_SITE);
    expect(old.status).toBe(404);
    expect((await asDemo("demo-team").get("/api/tickets/SUP-2")).body).toMatchObject({
      change_url: null,
      ready_at: null,
    });
  });

  it("leaves no styles behind for the removed sample fix", () => {
    expect(fs.readFileSync("public/site.css", "utf8")).not.toContain("sample-fix");
  });
});

describe("the header on a phone", () => {
  it("keeps Sign out on one line and lets the role switch grow with its words", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 639px)"));
    expect(phone).toMatch(/\.site-header \.sign-out button \{[^}]*white-space: nowrap/);
    expect(phone).toMatch(/details\.dropdown\.switch-role > summary \{[^}]*height: auto/);
  });
});

// The team's one primary button is always the step that is possible now, and leads to a control
// that works, never to a greyed one.
describe("the team's next step", () => {
  type Page = ReturnType<typeof parse>;
  const step = (page: Page) => {
    const area = page.querySelector(".next-action");
    if (area === null) return null;
    const control = area.querySelector("button, a[role=button]")!;
    return {
      label: control.text.trim(),
      to: control.getAttribute("href") ?? area.querySelector("form")?.getAttribute("action"),
      note: area.querySelector(".next-note")?.text ?? null,
    };
  };

  it("on the real site: take, ask, then nothing while the customer answers", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const page = async () => parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(step(await page())).toEqual({
      label: "Take ticket and start work",
      to: "/tickets/SUP-1/take-and-start",
      note: null,
    });

    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const askStep = await page();
    expect(step(askStep)).toEqual({
      label: "Ask the customer to verify",
      to: "/tickets/SUP-1/ready",
      note: 'Sends the customer "Did this fix it?".',
    });
    // The longer form, with its optional boxes, works too: never a greyed button.
    expect(askStep.querySelector("form#ask button[type=submit]")?.hasAttribute("disabled")).toBe(
      false,
    );

    // Pressing the step sends the form as it is, with no fields.
    expect((await as(app, teamActor).post("/tickets/SUP-1/ready")).status).toBe(303);
    expect(step(await page())).toBeNull();
    // Someone who does not own it has no step to take.
    expect(step(parse((await admin(app).get("/tickets/SUP-1")).text))).toBeNull();
  });

  it("asks the customer to verify even when they never said how they will know", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(step(page)?.label).toBe("Ask the customer to verify");
    expect((await as(app, teamActor).post("/tickets/SUP-1/ready")).status).toBe(303);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.waiting_on).toBe("customer");
  });
});
