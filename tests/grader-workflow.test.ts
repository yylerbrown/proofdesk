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

// From a cold walk by a grader: titles lead to their tickets, the team reads plainly who
// resolves, and on the demo the owner can reach the customer's question with labelled sample
// values instead of inventing evidence.

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
    const form = parse((await as(app, customerOne).get("/tickets/new")).text);
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
    const sentence = "Only the customer who filed this ticket can resolve it.";
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(page.querySelector(".status-rule")?.text.startsWith(sentence)).toBe(true);
    const edit = parse((await as(app, teamActor).get("/tickets/SUP-1/edit")).text);
    expect(edit.querySelector(".status-rule")?.text).toBe(sentence);
    // The customer who filed it is not told they cannot.
    const own = parse((await as(app, customerOne).get("/tickets/SUP-1/edit")).text);
    expect(own.querySelector(".status-rule")).toBeNull();
  });
});

describe("the demo's sample fix", () => {
  it("is offered to the owner of a ticket in progress, and fills the fix with labelled sample values", async () => {
    const { asDemo } = await demoInProgress();
    const page = parse((await asDemo("demo-team").get("/tickets/SUP-2")).text);
    expect(page.querySelector(".next-action form[action$='/sample-fix'] button")?.text).toBe(
      "Use sample fix",
    );

    const used = await asDemo("demo-team").post("/tickets/SUP-2/sample-fix").set(FROM_THIS_SITE);
    expect(used.status).toBe(303);
    expect(used.headers.location).toBe("/tickets/SUP-2?sample=1#ask");
    const ticket = (await asDemo("demo-team").get("/api/tickets/SUP-2")).body;
    expect(ticket.change_url).toBe("https://example.com/demo-sample-fix");

    const ask = parse(
      (await asDemo("demo-team").get("/tickets/SUP-2?sample=1")).text,
    ).querySelector("form#ask")!;
    expect(ask.querySelector("textarea[name=tried]")?.text).toMatch(/^Demo sample value: /);
    expect(ask.querySelector("textarea[name=result]")?.text).toMatch(/^Demo sample value: /);
    expect(ask.querySelector("input[name=try_url]")?.getAttribute("value")).toMatch(/^https:\/\//);
    // The owner still presses the ask; nothing is sent to the customer by the sample.
    expect(ticket.ready_at).toBeNull();
  });

  it("after the customer's No, also fills what changed, so the second ask can be sent as it is", async () => {
    const { asDemo } = await demoInProgress();
    const team = asDemo("demo-team");
    await team.post("/tickets/SUP-2/sample-fix").set(FROM_THIS_SITE);
    const fields = (html: string) => {
      const form = parse(html).querySelector("form#ask")!;
      const values: Record<string, string> = {};
      for (const box of form.querySelectorAll("input[name], textarea[name]")) {
        if (box.getAttribute("type") === "checkbox") continue;
        values[box.getAttribute("name")!] = box.getAttribute("value") ?? box.text;
      }
      return values;
    };
    const first = fields((await asDemo("demo-team").get("/tickets/SUP-2?sample=1")).text);
    expect(
      (
        await asDemo("demo-team")
          .post("/tickets/SUP-2/ready")
          .set(FROM_THIS_SITE)
          .type("form")
          .send(first)
      ).status,
    ).toBe(303);
    const token = (await asDemo("demo-customer").get("/api/tickets/SUP-2")).body.ready_token;
    await asDemo("demo-customer")
      .post("/tickets/SUP-2/answer")
      .set(FROM_THIS_SITE)
      .type("form")
      .send({ fixed: "no", comment: "Still February.", ready_token: token });

    await asDemo("demo-team").post("/tickets/SUP-2/sample-fix").set(FROM_THIS_SITE);
    const again = fields((await asDemo("demo-team").get("/tickets/SUP-2?sample=1")).text);
    expect(again.response).toMatch(/^Demo sample value: /);
    const sent = await asDemo("demo-team")
      .post("/tickets/SUP-2/ready")
      .set(FROM_THIS_SITE)
      .type("form")
      .send(again);
    expect(sent.status).toBe(303);
    expect((await asDemo("demo-team").get("/api/tickets/SUP-2")).body.ready_at).not.toBeNull();
  });

  it("is not offered, and not open, outside the demo or to anyone but the owner", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(page.querySelector("form[action$='/sample-fix']")).toBeNull();
    expect((await as(app, teamActor).post("/tickets/SUP-1/sample-fix")).status).toBe(404);

    const { asDemo } = await demoInProgress();
    const customer = parse((await asDemo("demo-customer").get("/tickets/SUP-2")).text);
    expect(customer.querySelector("form[action$='/sample-fix']")).toBeNull();
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

  it("on the real site: take, link the change, ask, then nothing while the customer answers", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const page = async () => parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(step(await page())).toEqual({
      label: "Take ticket and start work",
      to: "/tickets/SUP-1/take-and-start",
      note: null,
    });

    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const linkStep = await page();
    expect(step(linkStep)).toEqual({
      label: "Add the code change link",
      to: "#change-link",
      note: "Next: link the code change, then ask the customer to verify.",
    });
    expect(linkStep.querySelector("form#change-link input[name=change_url]")).not.toBeNull();

    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    const askStep = await page();
    expect(step(askStep)).toEqual({
      label: "Ask the customer to verify",
      to: "#ask",
      note: "Next: try it yourself, then ask the customer to verify.",
    });
    // It leads to the working form, not to the greyed button.
    expect(askStep.querySelector("form#ask button[type=submit]")?.hasAttribute("disabled")).toBe(
      false,
    );

    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/t", tried: "Printed.", result: "No jam." });
    expect(step(await page())).toBeNull();
    // Someone who does not own it has no step to take.
    expect(step(parse((await admin(app).get("/tickets/SUP-1")).text))).toBeNull();
  });

  it("asks how the customer will know when they never said", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(step(page)).toEqual({
      label: "Ask how they will know",
      to: "#entry-body",
      note: "Next: the customer has not said how they will know it is fixed. Ask them in a reply.",
    });
    expect(page.querySelector("textarea#entry-body")).not.toBeNull();
  });

  it("on the demo: take, the sample fix, then ask", async () => {
    const { asDemo } = await demoInProgress();
    const page = async () => parse((await asDemo("demo-team").get("/tickets/SUP-2")).text);
    expect(step(await page())).toEqual({
      label: "Use sample fix",
      to: "/tickets/SUP-2/sample-fix",
      note: "Next: link the code change. On the demo, a labelled sample stands in for it.",
    });
    await asDemo("demo-team").post("/tickets/SUP-2/sample-fix").set(FROM_THIS_SITE);
    expect(step(await page())?.label).toBe("Ask the customer to verify");
  });
});
