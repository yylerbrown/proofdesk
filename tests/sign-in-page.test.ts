import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, SIGN_IN_ENV, visitor } from "./helpers.js";

// The real site's sign-in page says what it is for, who can sign in and what Proofdesk reads
// from GitHub. That someone signed in gets no GitHub button is in github-callback.test.ts,
// which signs a person in through GitHub.

const signInPage = async (request: Promise<{ text: string }>) => parse((await request).text);

describe("the real site's sign-in page", () => {
  it("is headed Sign in to Proofdesk, with the sentence that says what it is", async () => {
    const { app } = buildTestApp(SIGN_IN_ENV);
    const html = await signInPage(visitor(app).get("/sign-in"));
    expect(html.querySelector("h1")?.text).toBe("Sign in to Proofdesk");
    expect(html.querySelector("hgroup p")?.text).toBe(
      "Proofdesk is a support desk where a ticket is shaped like a good prompt: the problem, the context, and what would prove it is fixed.",
    );
  });

  it("puts GitHub's mark on the button and says who can sign in and what is read", async () => {
    const { app } = buildTestApp(SIGN_IN_ENV);
    const html = await signInPage(visitor(app).get("/sign-in"));
    const button = html.querySelector("form[action='/sign-in/github'] button");
    expect(button?.text).toBe("Sign in with GitHub");
    expect(button?.querySelector(".github-mark")?.getAttribute("aria-hidden")).toBe("true");
    // The line under the button is the button's description.
    const describedBy = button?.getAttribute("aria-describedby");
    expect(html.querySelector("form + .github-reads")?.getAttribute("id")).toBe(describedBy);
    expect(html.getElementById(describedBy ?? "")?.text).toBe(
      "Anyone with a GitHub account can sign in. Proofdesk reads your name, picture and email address, never your code.",
    );
  });

  it("serves GitHub's mark from this site, so the page needs no other address", async () => {
    const { app } = buildTestApp(SIGN_IN_ENV);
    const res = await visitor(app).get("/assets/github-mark.svg");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    const css = await visitor(app).get("/assets/site.css");
    expect(css.text).toContain('url("/assets/github-mark.svg")');
  });
});

describe("the page about the demo", () => {
  it("is headed for what it is and has no GitHub button", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const html = await signInPage(visitor(built.app).get("/sign-in"));
    expect(html.querySelector("h1")?.text).toBe("About this demo");
    expect(html.querySelector(".github-reads")).toBeNull();
  });
});
