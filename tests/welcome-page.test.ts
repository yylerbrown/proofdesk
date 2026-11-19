import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/server/demo.js";
import { ticketFromNext } from "../src/server/routes/sign-in.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, SIGN_IN_ENV, visitor } from "./helpers.js";

// The welcome page ties each explanation to its button, names the ticket a link asked for,
// and is titled for what it is.

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}

async function page(app: ReturnType<typeof demo>["app"], address = "/sign-in") {
  return parse((await visitor(app).get(address)).text);
}

/** The text a screen reader gives as a button's description, from its aria-describedby. */
function description(html: ReturnType<typeof parse>, button: ReturnType<typeof parse> | null) {
  const ids = button?.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => html.getElementById(id)?.text.trim()).join(" ");
}

describe("the welcome page's buttons", () => {
  it("describe 'Try the ticket workflow' with its steps, right after the button", async () => {
    const html = await page(demo().app);
    const button = html.querySelector("form.try-workflow button");
    expect(description(html, button)).toContain("File a ticket as the customer");
    expect(html.querySelector("form.try-workflow + .try-steps")).not.toBeNull();
  });

  it("describe each role button with its own line", async () => {
    const html = await page(demo().app);
    const rows = html.querySelectorAll(".people li");
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(description(html, row.querySelector("button"))).toBe(
        row.querySelector(".try")?.text.trim(),
      );
    }
  });
});

describe("the demo welcome's first screen", () => {
  it("goes from the workflow's steps straight to the roles, with Source and setup under them", async () => {
    const built = buildTestApp({
      DEMO: "on",
      DEV_SIGN_IN: "off",
      SOURCE_URL: "https://code.example.com/team/desk",
    });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const html = await page(built.app);
    // Nothing sits between the steps and the roles, so all three roles fit on a laptop's
    // first screen. The source link waits under them, and the assistant setup stays last.
    expect(
      html.querySelector(".try-steps + h3 + ul.people + .source-link + details.connect"),
    ).not.toBeNull();
    expect(html.querySelectorAll(".source-link").length).toBe(1);
    expect(html.querySelector("section")!.lastElementChild?.classNames).toBe("connect");
  });

  it("keeps each role's line on one row at laptop width, and the steps right under their button", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    expect(css).toMatch(/\.welcome \{\s*max-width: 520px;/);
    expect(css).toMatch(/\.try-workflow button \{\s*width: 100%;\s*margin-bottom: 0;/);
  });
});

describe("the welcome page's assistant setup", () => {
  it("is one closed line at the end, after the roles, with everything about keys inside it", async () => {
    const html = await page(demo().app);
    const section = html.querySelector("section")!;
    const folded = section.lastElementChild!;
    expect(folded.tagName).toBe("DETAILS");
    expect(folded.hasAttribute("open")).toBe(false);
    expect(folded.querySelector("summary")?.text).toBe("Connect your own AI assistant");
    expect(folded.previousElementSibling?.classNames).toBe("people");
    // The key button, its explanation and the recorded run are all folded away.
    expect(folded.querySelector("form[action='/demo/connection'] button")?.text).toBe(
      "Get a demo connection",
    );
    expect(folded.text).toContain("A key is shown only once");
    expect(folded.querySelector("a[href='/assistant-run']")).not.toBeNull();
    const outside = section.childNodes.filter((node) => node !== folded);
    expect(outside.map((node) => node.text).join(" ")).not.toMatch(/key|assistant/i);
    // Its summary reads as a quiet link, like the other small disclosures, not a full-width row.
    const css = fs.readFileSync("public/site.css", "utf8");
    expect(css).toMatch(/\.welcome details\.connect > summary \{\s*display: inline-block;/);
  });

  it("explains itself, once opened, in muted small print like the rest of the page", async () => {
    const html = await page(demo().app);
    const explanation = html.querySelector("#connect > p");
    expect(explanation?.text).toContain("Get a key for your own assistant");
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

describe("a welcome page reached from a ticket link", () => {
  it("names the ticket above the big button, and says the workflow files a new one", async () => {
    const html = await page(demo().app, "/sign-in?next=%2Ftickets%2FSUP-8");
    expect(html.querySelector(".next-ticket + form.try-workflow")).not.toBeNull();
    expect(html.querySelector(".next-ticket")?.text).toBe(
      "Pick a role below to open SUP-8. Try the ticket workflow files a new ticket instead.",
    );
    // Each role button's description says which ticket it opens.
    const first = html.querySelector(".people li button");
    expect(description(html, first)).toMatch(/^Pick a role below to open SUP-8\./);
  });

  it("names the ticket on the development entrance too", async () => {
    const { app } = buildTestApp();
    const html = await page(app, "/sign-in?next=%2Ftickets%2FSUP-3");
    expect(html.querySelector(".next-ticket")?.text).toBe("Pick a person below to open SUP-3.");
  });

  it("names nothing for any other address", async () => {
    const { app } = demo();
    for (const next of ["/tickets", "/tickets/new", "/tickets/SUP-8/edit", "https://elsewhere"]) {
      const html = await page(app, `/sign-in?next=${encodeURIComponent(next)}`);
      expect(html.querySelector(".next-ticket")).toBeNull();
      expect(html.querySelector(".people li button")?.getAttribute("aria-describedby")).toBe(
        "try-demo-customer",
      );
    }
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

describe("the welcome page's tab title", () => {
  const title = async (response: Promise<{ text: string }>) =>
    parse((await response).text).querySelector("title")?.text;

  it("is Welcome on the demo", async () => {
    expect(await title(visitor(demo().app).get("/sign-in"))).toBe("Welcome - Proofdesk");
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
