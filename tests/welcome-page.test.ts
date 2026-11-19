import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/server/demo.js";
import { ticketFromNext } from "../src/server/routes/sign-in.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { as, buildTestApp, customerOne, SIGN_IN_ENV, visitor } from "./helpers.js";

// The demo's welcome card above a first-time visitor's list, and the page about the demo that
// took over everything else the old welcome page held: each explanation is tied to its button,
// a link to one ticket is named, and each page is titled for what it is.

function demo(env: NodeJS.ProcessEnv = {}) {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off", ...env });
  const service = createTicketService(built.db, built.config.ticketPrefix);
  seedDemo(service);
  return { ...built, recorded: service.recordedRunKey()! };
}

async function page(app: ReturnType<typeof demo>["app"], address = "/sign-in") {
  return parse((await visitor(app).get(address)).text);
}

/** A page as one of the demo people sees it. */
async function pageAs(app: ReturnType<typeof demo>["app"], id: string, address: string) {
  return parse((await visitor(app).get(address).set("Cookie", `${DEV_COOKIE}=${id}`)).text);
}

/** The text a screen reader gives as a button's description, from its aria-describedby. */
function description(html: ReturnType<typeof parse>, button: ReturnType<typeof parse> | null) {
  const ids = button?.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => html.getElementById(id)?.text.trim()).join(" ");
}

describe("the demo's welcome card", () => {
  it("says what this is in one sentence, with one button and a quiet line of links", async () => {
    const html = await page(demo().app, "/tickets");
    const card = html.querySelector("main > .demo-welcome")!;
    expect(card.querySelector("p")?.text).toBe(
      "Proofdesk is a support desk where the customer says how they will know a fix worked. You are trying it as a customer.",
    );
    const buttons = card.querySelectorAll("[role=button], button:not(.link)");
    expect(buttons.map((button) => button.text)).toEqual(["File a sample ticket"]);
    const links = card.querySelectorAll(".demo-welcome-more button").map((b) => b.text);
    expect(links).toEqual([
      "See the team's side",
      "See a ticket an AI assistant worked, as the team",
      "Hide",
    ]);
    // It comes before the list's heading, so the first screen leads with it.
    expect(card.nextElementSibling?.tagName).toBe("H1");
  });

  it("switches to the team member's list with See the team's side", async () => {
    const html = await page(demo().app, "/tickets");
    const form = html.querySelectorAll(".demo-welcome-more form")[0]!;
    expect(form.getAttribute("action")).toBe("/sign-in/dev");
    expect(form.querySelector("input[name='id']")?.getAttribute("value")).toBe("demo-team");
    expect(form.querySelector("input[name='next']")?.getAttribute("value")).toBe("/tickets");
  });

  it("is only on the list, and only for the demo customer", async () => {
    const { app } = demo();
    const ticketPage = await pageAs(app, "demo-customer", "/tickets/SUP-3");
    expect(ticketPage.querySelector(".demo-welcome")).toBeNull();
    for (const id of ["demo-team", "demo-admin"]) {
      expect((await pageAs(app, id, "/tickets")).querySelector(".demo-welcome")).toBeNull();
    }
    const { app: real } = buildTestApp();
    const realList = parse((await as(real, customerOne).get("/tickets")).text);
    expect(realList.querySelector(".demo-welcome")).toBeNull();
  });

  it("goes for good once hidden, in that browser, with no script", async () => {
    const { app } = demo();
    const browser = visitor(app);
    const first = parse((await browser.get("/tickets")).text);
    expect(first.querySelector(".demo-welcome")).not.toBeNull();
    const hidden = await browser.post("/welcome/hide");
    expect(hidden.status).toBe(303);
    expect(hidden.headers.location).toBe("/tickets");
    expect(String(hidden.headers["set-cookie"])).toMatch(/demo_welcome=hidden;.*Max-Age=/);
    const after = parse((await browser.get("/tickets")).text);
    expect(after.querySelector(".demo-welcome")).toBeNull();
  });

  it("keeps its links small and quiet, with Hide at the end of their line", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    expect(css).toMatch(/\.demo-welcome-more \{[^}]*font-size: var\(--pd-text-sm\);/);
    expect(css).toMatch(/\.demo-welcome-more \.demo-welcome-hide \{\s*margin-inline-start: auto;/);
  });
});

describe("the welcome card's way to a ticket an AI assistant worked", () => {
  // It says "as the team", because pressing it changes the visitor's role.
  const LABEL = "See a ticket an AI assistant worked, as the team";

  it("switches to the team in the same press, opening the recorded run's ticket", async () => {
    const { app, recorded } = demo();
    const html = await page(app, "/tickets");
    const buttons = html.querySelectorAll(".demo-welcome-more button");
    const button = buttons.find((b) => b.text === LABEL)!;
    const form = button.parentNode!;
    expect(form.getAttribute("action")).toBe("/sign-in/dev");
    expect(form.querySelector("input[name='id']")?.getAttribute("value")).toBe("demo-team");
    expect(form.querySelector("input[name='next']")?.getAttribute("value")).toBe(
      `/tickets/${recorded}`,
    );
    // A text button, so it reads as a link and not as a second big choice.
    expect(button.classNames).toBe("link");
  });

  it("opens the recorded ticket in the team's view in one press", async () => {
    const { app, recorded } = demo();
    const browser = visitor(app);
    const pressed = await browser
      .post("/sign-in/dev")
      .type("form")
      .send({ id: "demo-team", next: `/tickets/${recorded}` });
    expect(pressed.status).toBe(303);
    expect(pressed.headers.location).toBe(`/tickets/${recorded}`);
    const ticket = parse((await browser.get(`/tickets/${recorded}`)).text);
    expect(ticket.querySelector(".recorded-run")).not.toBeNull();
  });

  it("is not offered before the demo is seeded", async () => {
    const unseeded = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const html = parse((await visitor(unseeded.app).get("/tickets")).text);
    expect(html.querySelector(".demo-welcome")).not.toBeNull();
    expect(html.querySelector(".demo-welcome")!.text).not.toContain(LABEL);
  });
});

describe("the roles in the demo's person menu", () => {
  it("lists the three people by name, the current one named and not offered", async () => {
    const html = await pageAs(demo().app, "demo-customer", "/tickets");
    const rows = html.querySelectorAll("header .person-menu ul li.role");
    expect(rows.length).toBe(3);
    expect(rows[0]!.querySelector("button")).toBeNull();
    expect(rows[0]!.querySelector(".role-current")?.text).toBe("Demo Customer (you)");
    expect(rows.slice(1).map((row) => row.querySelector("button")?.text)).toEqual([
      "Demo Team Member",
      "Demo Admin (read-only)",
    ]);
    // A name is the whole choice: no line under it to describe it.
    expect(html.querySelector("header .person-menu [aria-describedby]")).toBeNull();
  });
});

describe("the page about the demo", () => {
  it("holds the privacy note, the real site, the source and the folded assistant setup, in that order", async () => {
    const { app } = demo({
      SOURCE_URL: "https://code.example.com/team/desk",
      REAL_SITE_URL: "https://desk.example.com",
    });
    const html = await page(app);
    const parts = html.querySelector("section.about-demo")!.children;
    expect(parts.map((node) => node.classNames)).toEqual([
      "",
      "real-site",
      "source-link",
      "connect",
    ]);
    expect(parts[0]!.text).toContain("Do not type anything private here.");
  });

  it("tells a signed-in visitor who they are once, then one row of links", async () => {
    const { app } = demo({
      SOURCE_URL: "https://code.example.com/team/desk",
      REAL_SITE_URL: "https://desk.example.com",
    });
    const html = await pageAs(app, "demo-team", "/sign-in");
    const main = html.querySelector("main")!;
    expect(main.querySelector(".signed-in")?.text).toBe(
      "You are Demo Team Member, one of three made-up people. Switch with the menu at the top right. " +
        "On the real site, people sign in with GitHub. How sign-in and roles work",
    );
    expect(main.querySelector(".real-site")).toBeNull();
    expect(main.text.match(/three made-up people/g)).toHaveLength(1);
    const links = main.querySelector(".source-link")!;
    expect(links.text).toBe("Back to the tickets · Source and setup");
    expect(links.querySelectorAll("a").map((a) => a.getAttribute("href"))).toEqual([
      "/tickets",
      "https://code.example.com/team/desk#readme",
    ]);
    // Then the closed line for the assistant setup.
    expect(links.nextElementSibling?.tagName).toBe("DETAILS");
  });

  it("gives a signed-out visitor one button to start again as the customer", async () => {
    const html = await page(demo().app);
    const main = html.querySelector("main")!;
    expect(main.querySelectorAll("button:not(.link)").map((b) => b.text)[0]).toBe("Start again");
    const form = main.querySelector("form.start-again")!;
    expect(form.getAttribute("action")).toBe("/sign-in/dev");
    expect(form.querySelector("input[name='id']")?.getAttribute("value")).toBe("demo-customer");
    expect(form.querySelector("input[name='next']")?.getAttribute("value")).toBe("/tickets");
  });

  it("is where Sign out on the demo leads", async () => {
    const { app } = demo();
    const out = await visitor(app).post("/sign-out").set("Cookie", `${DEV_COOKIE}=demo-team`);
    expect(out.headers.location).toBe("/sign-in");
  });

  it("keeps the old welcome page's width", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    expect(css).toMatch(/\.welcome \{\s*max-width: 520px;/);
  });
});

describe("the About page's assistant setup", () => {
  it("is one closed line at the end, with everything about keys inside it", async () => {
    const html = await page(demo().app);
    const section = html.querySelector("section.about-demo")!;
    const folded = section.lastElementChild!;
    expect(folded.tagName).toBe("DETAILS");
    expect(folded.hasAttribute("open")).toBe(false);
    expect(folded.querySelector("summary")?.text).toBe("Connect your own AI assistant");
    // Inside it, one sentence and the one button, and nothing else.
    const inside = folded.querySelector("#connect")!;
    expect(inside.childNodes.filter((n) => n.nodeType === 1).map((n) => n.rawTagName)).toEqual([
      "p",
      "form",
    ]);
    expect(inside.querySelector("form[action='/demo/connection'] button")?.text).toBe(
      "Get a demo connection",
    );
    // Outside it, nothing on the page speaks of a key or an assistant.
    const outside = html.querySelector("main")!.text.replace(folded.text, "");
    expect(outside).not.toMatch(/key|assistant/i);
    // Its summary reads as a quiet link, like the other small disclosures, not a full-width row.
    const css = fs.readFileSync("public/site.css", "utf8");
    expect(css).toMatch(/\.welcome details\.connect > summary \{\s*display: inline-block;/);
  });

  it("explains itself, once opened, in muted small print like the rest of the page", async () => {
    const html = await page(demo().app);
    const explanation = html.querySelector("#connect > p");
    expect(explanation?.text).toBe(
      "Get a one-day key and one message to paste into your own AI assistant, so it can work on the sample ticket made for it.",
    );
    expect(explanation?.classNames).not.toContain("notice");
    const css = fs.readFileSync("public/site.css", "utf8");
    expect(css).toMatch(
      /\.welcome #connect > p:not\(\.notice\) \{\s*color: var\(--pd-muted\);\s*font-size: var\(--pd-text-sm\);/,
    );
  });

  it("opens by itself for links to #connect, which name a place inside it, with no script", async () => {
    const html = await page(demo().app);
    // A browser opens a closed details element when the address's #part names something in its
    // content. The summary or the details element itself would not open it.
    const target = html.getElementById("connect")!;
    expect(target.parentNode?.tagName).toBe("DETAILS");
    expect(target.tagName).not.toBe("SUMMARY");
    expect(target.querySelector("form[action='/demo/connection']")).not.toBeNull();
  });
});

describe("the About page reached from a ticket link", () => {
  it("names the ticket and offers each role, described by its line and the ticket", async () => {
    const html = await page(demo().app, "/sign-in?next=%2Ftickets%2FSUP-8");
    expect(html.querySelector(".next-ticket")?.text).toBe("Pick a role to open SUP-8.");
    expect(html.querySelector(".next-ticket + ul.people")).not.toBeNull();
    const rows = html.querySelectorAll(".people li");
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.querySelector("input[name='next']")?.getAttribute("value")).toBe("/tickets/SUP-8");
      expect(description(html, row.querySelector("button"))).toBe(
        `Pick a role to open SUP-8. ${row.querySelector(".try")?.text.trim()}`,
      );
    }
    // The single start button is for a visitor with no ticket in mind.
    expect(html.querySelector("form.start-again")).toBeNull();
  });

  it("names the ticket on the development entrance too", async () => {
    const { app } = buildTestApp();
    const html = parse((await visitor(app).get("/sign-in?next=%2Ftickets%2FSUP-3")).text);
    expect(html.querySelector(".next-ticket")?.text).toBe("Pick a person below to open SUP-3.");
  });

  it("names nothing for any other address, and starts there as the customer", async () => {
    const { app } = demo();
    for (const next of ["/tickets/new", "/tickets/SUP-8/edit", "/notices"]) {
      const html = await page(app, `/sign-in?next=${encodeURIComponent(next)}`);
      expect(html.querySelector(".next-ticket")).toBeNull();
      const start = html.querySelector("form.start-again")!;
      expect(start.querySelector("input[name='next']")?.getAttribute("value")).toBe(next);
      expect(start.querySelector("button")?.text).toBe("Continue as the demo customer");
    }
    // An address on another site falls back to the list.
    const elsewhere = await page(app, `/sign-in?next=${encodeURIComponent("https://elsewhere")}`);
    const fallback = elsewhere.querySelector("form.start-again input[name='next']");
    expect(fallback?.getAttribute("value")).toBe("/tickets");
  });
});

describe("ticketFromNext", () => {
  it("gives the key only for one ticket's page with this site's prefix", () => {
    expect(ticketFromNext("/tickets/SUP-8", "SUP")).toBe("SUP-8");
    expect(ticketFromNext("/tickets/SUP-08", "SUP")).toBeNull();
    expect(ticketFromNext("/tickets/ABC-8", "SUP")).toBeNull();
    expect(ticketFromNext("/tickets/SUP-8?tab=history", "SUP")).toBeNull();
    expect(ticketFromNext("/tickets/SUP-8/", "SUP")).toBeNull();
    expect(ticketFromNext("/tickets/<b>", "SUP")).toBeNull();
  });
});

describe("the sign-in page's tab title", () => {
  const title = async (response: Promise<{ text: string }>) =>
    parse((await response).text).querySelector("title")?.text;

  it("is About this demo on the demo", async () => {
    expect(await title(visitor(demo().app).get("/sign-in"))).toBe("About this demo - Proofdesk");
  });

  it("is Welcome for someone signed in", async () => {
    const { app } = buildTestApp();
    expect(await title(as(app, customerOne).get("/sign-in"))).toBe("Welcome - Proofdesk");
  });

  it("stays Sign in for a signed-out visitor on the real site", async () => {
    const { app } = buildTestApp(SIGN_IN_ENV);
    expect(await title(visitor(app).get("/sign-in"))).toBe("Sign in - Proofdesk");
  });
});
