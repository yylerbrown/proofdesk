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

describe("the demo's first landing", () => {
  it("opens a visitor with no sign-in on the ticket list, as the demo customer", async () => {
    const { app } = buildDemo();
    const home = await visitor(app).get("/");
    expect(home.headers.location).toBe("/tickets");
    const res = await visitor(app).get("/tickets");
    expect(res.status).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain(`${DEV_COOKIE}=demo-customer`);
    const html = parse(res.text);
    expect(html.querySelector("h1")?.text).toBe("My tickets");
    expect(html.querySelector("header .viewer strong")?.text).toBe("Demo Customer");
  });

  it("leads with one button, File a sample ticket, and keeps the assistant offer on the About page", async () => {
    const { app } = buildDemo();
    const main = parse((await visitor(app).get("/tickets")).text).querySelector("main")!;
    const start = main.querySelector(".demo-welcome [role=button]")!;
    expect(start.text).toBe("File a sample ticket");
    expect(main.querySelectorAll(".demo-welcome [role=button]").length).toBe(1);
    expect(main.querySelector("form[action='/demo/connection']")).toBeNull();
    // On the About page the offer comes after the privacy note, and never as the strong button.
    const about = parse((await visitor(app).get("/sign-in")).text).querySelector("main")!;
    const offer = about.querySelector("form[action='/demo/connection']")!;
    const privacy = about.querySelector(".about-demo > p")!;
    expect(privacy.text).toContain("Do not type anything private here.");
    expect(about.toString().indexOf(offer.toString())).toBeGreaterThan(
      about.toString().indexOf(privacy.toString()),
    );
    expect(offer.querySelector("button")?.classList.contains("secondary")).toBe(true);
  });

  it("tells a signed-in demo visitor to switch role, not to sign out", async () => {
    const { app } = buildDemo();
    const html = parse((await asDemo(app, "demo-team").get("/sign-in")).text);
    const line = html.querySelector(".signed-in")!.text;
    expect(line).toContain("Switch with the menu at the top right.");
    // Said once: the page has no second way of saying it.
    expect(html.querySelector("main")!.text).not.toContain("Switch role at the top");
    expect(line).not.toContain("sign out");
  });

  it("starts the workflow as the demo customer, on a new ticket filled with a sample", async () => {
    const { app } = buildDemo();
    const html = parse((await visitor(app).get("/tickets")).text);
    const start = html.querySelector(".demo-welcome [role=button]")!;
    expect(start.getAttribute("href")).toBe("/tickets/new?try=1");
    const form = parse(
      (await asDemo(app, "demo-customer").get("/tickets/new?try=1").redirects(1)).text,
    );
    expect(form.querySelector("input[name=title]")?.getAttribute("value")).toBe(
      "The export button downloads an empty file",
    );
    // What would prove it is fixed is the step after filing, where the sample's choices wait.
    expect(form.querySelector("[name=fix_check]")).toBeNull();
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

    // Until the team asks, its own next step is the one thing to press: no switch back yet.
    const asTeam = parse((await asDemo(app, "demo-team").get(`/tickets/${key}`)).text);
    expect(asTeam.querySelector(".demo-next")).toBeNull();

    // The team works it and asks; then the customer who filed it is the next view.
    const team = (path: string) =>
      asDemo(app, "demo-team").post(path).set(FROM_THIS_SITE).type("form");
    await team(`/tickets/${key}/take-and-start`).send({});
    await team(`/tickets/${key}/change-link`).send({ change_url: "https://example.com/c" });
    await team(`/tickets/${key}/ready`).send({
      try_url: "https://example.com/reports",
      tried: "Exported it.",
      result: "Every row.",
    });
    const asked = parse((await asDemo(app, "demo-team").get(`/tickets/${key}`)).text);
    const toCustomer = asked.querySelector(".demo-next form")!;
    expect(toCustomer.querySelector("button")?.text).toBe(
      "View this ticket as the customer who filed it",
    );
    expect(await switchRole(app, "demo-team", toCustomer)).toMatchObject({
      status: 303,
      to: `/tickets/${key}`,
      as: "demo-customer",
    });

    // The customer says Yes.
    const ticket = (await asDemo(app, "demo-customer").get(`/api/tickets/${key}`)).body;
    await asDemo(app, "demo-customer")
      .post(`/tickets/${key}/answer`)
      .set(FROM_THIS_SITE)
      .type("form")
      .send({ fixed: "yes", ready_token: ticket.ready_token });
    const resolved = parse((await asDemo(app, "demo-customer").get(`/tickets/${key}`)).text);
    // The confirmed card says the customer's Yes resolved it, and the way back is above the
    // title, so nothing more is added.
    expect(resolved.querySelector(".demo-next")).toBeNull();
    expect(resolved.text).not.toContain("See every resolved ticket");
  });

  it("offers a switch in the header that comes back to the page the visitor was on", async () => {
    const { app } = buildDemo();
    const html = parse((await asDemo(app, "demo-customer").get("/tickets/SUP-3")).text);
    const menu = html.querySelector("header details.person-menu")!;
    expect(menu.querySelector("summary")?.text).toContain("Demo Customer");
    expect(menu.querySelector(".menu-heading")?.text).toBe("Switch role");
    const forms = menu.querySelectorAll("form");
    expect(forms.map((f) => f.querySelector("button")?.text)).toEqual([
      "Demo Team Member",
      "Demo Admin (read-only)",
    ]);
    for (const form of forms) {
      expect(form.querySelector("input[name=next]")?.getAttribute("value")).toBe("/tickets/SUP-3");
    }
    expect(await switchRole(app, "demo-customer", forms[0]!)).toMatchObject({
      status: 303,
      to: "/tickets/SUP-3",
    });
  });

  it("is not offered outside the demo", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    const html = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(html.querySelector(".person-menu .role")).toBeNull();
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
  it("comes right under the status, alone until the customer is asked", async () => {
    const { app } = buildDemo();
    const html = parse((await asDemo(app, "demo-team").get("/tickets/SUP-2")).text);
    const main = html.querySelector("main")!.toString();
    const next = html.querySelector(".next-action button")!;
    expect(next.text).toBe("Take ticket and start work");
    expect(main.indexOf(html.querySelector("h1")!.toString())).toBeLessThan(
      main.indexOf(next.toString()),
    );
    // The switch to the customer waits until the team has asked them, so it never competes.
    expect(html.querySelector(".demo-next")).toBeNull();
  });

  it("offers the switch to the customer as a quieter button once they are asked", async () => {
    const { app } = buildDemo();
    const team = (path: string) =>
      asDemo(app, "demo-team").post(path).set(FROM_THIS_SITE).type("form");
    await team("/tickets/SUP-2/take-and-start").send({});
    await team("/tickets/SUP-2/ready").send({});
    const html = parse((await asDemo(app, "demo-team").get("/tickets/SUP-2")).text);
    const role = html.querySelector(".demo-next button")!;
    expect(role.text).toBe("View this ticket as the customer who filed it");
    expect(role.classList.contains("outline")).toBe(true);
  });
});
