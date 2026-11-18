import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { seedDemo } from "../src/server/demo.js";
import { as, buildTestApp, customerOne, FROM_THIS_SITE, SIGN_IN_ENV, visitor } from "./helpers.js";

// The demo's walk-through: one ticket, filed as the customer, worked as the team and answered
// as the customer who filed it, without losing the ticket when the visitor switches role.

function buildDemo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}

const asDemo = (app: Express, id: string) => visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);

/** Posts a role switch as the browser would, and says where it goes and who it signs in. */
async function switchRole(app: Express, from: string, form: ReturnType<typeof parse>) {
  const fields = Object.fromEntries(
    form
      .querySelectorAll("input[type=hidden]")
      .map((i) => [i.getAttribute("name")!, i.getAttribute("value")!]),
  );
  const res = await asDemo(app, from)
    .post(form.getAttribute("action")!)
    .set(FROM_THIS_SITE)
    .type("form")
    .send(fields);
  return { status: res.status, to: res.headers.location, as: fields.id };
}

describe("the demo's welcome", () => {
  it("leads with the ticket workflow, then the people, then the assistant offer as a quiet button", async () => {
    const { app } = buildDemo();
    const html = parse((await visitor(app).get("/sign-in")).text);
    const main = html.querySelector("main")!;
    const buttons = main.querySelectorAll("button").map((b) => b.text);
    expect(buttons[0]).toBe("Try the ticket workflow");
    expect(main.querySelector("form.try-workflow button")?.classList.contains("secondary")).toBe(
      false,
    );
    expect(buttons).toContain("Admin preview (read-only)");
    const people = main.querySelector(".people")!;
    const offer = main.querySelector("form[action='/demo/connection']")!;
    {
      // After the people in the page, and never the strong button.
      expect(main.toString().indexOf(offer.toString())).toBeGreaterThan(
        main.toString().indexOf(people.toString()),
      );
      expect(offer.querySelector("button")?.classList.contains("secondary")).toBe(true);
    }
  });

  it("tells a signed-in demo visitor to switch role, not to sign out", async () => {
    const { app } = buildDemo();
    const html = parse((await asDemo(app, "demo-team").get("/sign-in")).text);
    expect(html.querySelector(".signed-in")?.text).toContain("use Switch role at the top");
  });

  it("starts the workflow as the demo customer, on a new ticket filled with a sample", async () => {
    const { app } = buildDemo();
    const html = parse((await visitor(app).get("/sign-in")).text);
    const started = await switchRole(app, "", html.querySelector("form.try-workflow")!);
    expect(started).toMatchObject({ status: 303, to: "/tickets/new?try=1", as: "demo-customer" });
    const form = parse(
      (await asDemo(app, "demo-customer").get("/tickets/new?try=1").redirects(1)).text,
    );
    expect(form.querySelector("input[name=title]")?.getAttribute("value")).toBe(
      "The export button downloads an empty file",
    );
    expect(form.querySelector("textarea[name=fix_check]")?.text).toMatch(/every row/);
  });

  it("fills nothing in outside the demo", async () => {
    const { app } = buildTestApp();
    const form = parse((await as(app, customerOne).get("/tickets/new?try=1").redirects(1)).text);
    expect(form.querySelector("input[name=title]")?.getAttribute("value")).toBe("");
  });
});

describe("following one ticket across roles on the demo", () => {
  it("keeps the same ticket when switching from customer to team and back, then points at the resolved list", async () => {
    const { app } = buildDemo();
    const filed = await asDemo(app, "demo-customer")
      .post("/tickets")
      .set(FROM_THIS_SITE)
      .type("form")
      .send({
        title: "The export button downloads an empty file",
        description: "Only the header row.",
        where_url: "https://example.com/reports",
        fix_check: "The file has every row.",
      });
    const key = /\/tickets\/([A-Z]+-\d+)/.exec(filed.headers.location!)![1]!;

    const asCustomer = parse((await asDemo(app, "demo-customer").get(`/tickets/${key}`)).text);
    const toTeam = asCustomer.querySelector(".demo-next form")!;
    expect(toTeam.querySelector("button")?.text).toBe("View this ticket as a team member");
    expect(await switchRole(app, "demo-customer", toTeam)).toMatchObject({
      status: 303,
      to: `/tickets/${key}`,
      as: "demo-team",
    });

    const asTeam = parse((await asDemo(app, "demo-team").get(`/tickets/${key}`)).text);
    const toCustomer = asTeam.querySelector(".demo-next form")!;
    expect(toCustomer.querySelector("button")?.text).toBe(
      "View this ticket as the customer who filed it",
    );
    expect(await switchRole(app, "demo-team", toCustomer)).toMatchObject({
      status: 303,
      to: `/tickets/${key}`,
      as: "demo-customer",
    });

    // The team works it and asks; the customer says Yes.
    const team = (path: string) =>
      asDemo(app, "demo-team").post(path).set(FROM_THIS_SITE).type("form");
    await team(`/tickets/${key}/take-and-start`).send({});
    await team(`/tickets/${key}/change-link`).send({ change_url: "https://example.com/c" });
    await team(`/tickets/${key}/ready`).send({
      try_url: "https://example.com/reports",
      tried: "Exported it.",
      result: "Every row.",
    });
    const ticket = (await asDemo(app, "demo-customer").get(`/api/tickets/${key}`)).body;
    await asDemo(app, "demo-customer")
      .post(`/tickets/${key}/answer`)
      .set(FROM_THIS_SITE)
      .type("form")
      .send({ fixed: "yes", ready_token: ticket.ready_token });
    const resolved = parse((await asDemo(app, "demo-customer").get(`/tickets/${key}`)).text);
    expect(resolved.querySelector(".demo-next a")?.getAttribute("href")).toBe(
      "/tickets?status=resolved",
    );
  });

  it("offers a switch in the header that comes back to the page the visitor was on", async () => {
    const { app } = buildDemo();
    const html = parse((await asDemo(app, "demo-customer").get("/tickets/SUP-1")).text);
    const menu = html.querySelector("header details.switch-role")!;
    expect(menu.querySelector("summary")?.text).toContain("Switch role");
    const forms = menu.querySelectorAll("form");
    expect(forms.map((f) => f.querySelector("button")?.text)).toEqual([
      "View as Demo Team Member",
      "Admin preview (read-only)",
    ]);
    for (const form of forms) {
      expect(form.querySelector("input[name=next]")?.getAttribute("value")).toBe("/tickets/SUP-1");
    }
    expect(await switchRole(app, "demo-customer", forms[0]!)).toMatchObject({
      status: 303,
      to: "/tickets/SUP-1",
    });
  });

  it("is not offered outside the demo", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    const html = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(html.querySelector(".switch-role")).toBeNull();
    expect(html.querySelector(".demo-next")).toBeNull();
  });
});

describe("the real site's sign-in page", () => {
  it("links to the demo when its address is set, and not otherwise", async () => {
    const withDemo = buildTestApp({ ...SIGN_IN_ENV, DEMO_URL: "https://demo.example.com" });
    const page = parse((await visitor(withDemo.app).get("/sign-in")).text);
    const link = page.querySelector(".try-demo a");
    expect(link?.text).toBe("Try the demo without signing in");
    expect(link?.getAttribute("href")).toBe("https://demo.example.com");
    const without = buildTestApp(SIGN_IN_ENV);
    expect(
      parse((await visitor(without.app).get("/sign-in")).text).querySelector(".try-demo"),
    ).toBeNull();
  });
});

describe("the next action on the demo", () => {
  it("comes right under the status, before a quieter switch of role", async () => {
    const { app } = buildDemo();
    const html = parse((await asDemo(app, "demo-team").get("/tickets/SUP-2")).text);
    const main = html.querySelector("main")!.toString();
    const next = html.querySelector(".next-action button")!;
    expect(next.text).toBe("Take ticket and start work");
    const role = html.querySelector(".demo-next button")!;
    expect(role.text).toBe("View this ticket as the customer who filed it");
    expect(role.classList.contains("outline")).toBe(true);
    expect(main.indexOf(next.toString())).toBeLessThan(main.indexOf(role.toString()));
    expect(main.indexOf(html.querySelector("hgroup")!.toString())).toBeLessThan(
      main.indexOf(next.toString()),
    );
  });
});
