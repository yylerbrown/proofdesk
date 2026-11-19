import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { wireOpeningLinks, type OpeningLink, type Section } from "../src/browser/open-details.js";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Beside the top "Ask the customer to verify" button, one quiet link leads to the optional
// details form further down, inside "More options", so a person who wants to say what they
// tried finds where first.

describe("the link to the optional details", () => {
  it("sits beside the ask and leads to the details form", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x", fix_check: "Ten pages print" });
    const page = async () => parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    // Before the ticket is taken there is nothing to ask, so no link.
    expect((await page()).querySelector(".next-details")).toBeNull();

    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const html = await page();
    const link = html.querySelector(".next-action .next-details a")!;
    expect(link.text).toBe("Add details first (optional)");
    expect(link.getAttribute("href")).toBe("#ask");
    expect(link.getAttribute("data-opens")).toBe("ask");
    // It leads to the closed details form, which the page already has, inside More options.
    const details = html.querySelector("details.more-options details#ask")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("summary")?.text).toBe("Ask with details (optional)");
    // Nobody else sees it.
    expect(
      parse((await admin(app).get("/tickets/SUP-1")).text).querySelector(".next-details"),
    ).toBeNull();
  });
});

describe("the script that opens it", () => {
  it("opens the named section when the link is pressed, and leaves others alone", () => {
    const section: Section = { open: false };
    const other: Section = { open: false };
    let press: () => void = () => undefined;
    const link: OpeningLink = {
      dataset: { opens: "ask" },
      addEventListener: (_type, listener) => (press = listener),
    };
    wireOpeningLinks([link], (id) => (id === "ask" ? [section] : []));
    expect(section.open).toBe(false);
    press();
    expect(section.open).toBe(true);
    expect(other.open).toBe(false);
  });

  it("opens the closed section around the named one too", () => {
    const section: Section = { open: false };
    const around: Section = { open: false };
    let press: () => void = () => undefined;
    const link: OpeningLink = {
      dataset: { opens: "ask" },
      addEventListener: (_type, listener) => (press = listener),
    };
    wireOpeningLinks([link], (id) => (id === "ask" ? [section, around] : []));
    press();
    expect(section.open).toBe(true);
    expect(around.open).toBe(true);
  });

  it("does nothing when the section is not on the page", () => {
    let press: () => void = () => undefined;
    const link: OpeningLink = {
      dataset: { opens: "missing" },
      addEventListener: (_type, listener) => (press = listener),
    };
    wireOpeningLinks([link], () => []);
    expect(() => press()).not.toThrow();
  });
});
