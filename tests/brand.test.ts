import fs from "node:fs";
import { parse } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { admin, buildTestApp, visitor } from "./helpers.js";

// The name, the look and the mark. Structure only: which files are linked, in what order, and
// what each page says. The colours themselves are checked by eye and by measuring contrast.

const theme = fs.readFileSync("public/theme.css", "utf8");
const site = fs.readFileSync("public/site.css", "utf8");

describe("the name", () => {
  it("is Proofdesk in the header and in every page title", async () => {
    const { app } = buildTestApp();
    for (const address of ["/tickets", "/tickets/new"]) {
      const html = parse((await admin(app).get(address).redirects(1)).text);
      expect(html.querySelector("header .brand")?.text.trim()).toBe("Proofdesk");
      expect(html.querySelector("title")?.text).toMatch(/ - Proofdesk$/);
    }
    const signIn = parse((await visitor(app).get("/sign-in")).text);
    expect(signIn.querySelector("h1")?.text).toBe("Proofdesk");
  });

  it("is not Support Desk anywhere a visitor reads", () => {
    for (const file of fs.readdirSync("views")) {
      expect(fs.readFileSync(`views/${file}`, "utf8"), file).not.toContain("Support Desk");
    }
  });
});

describe("the theme", () => {
  it("is linked after the ready-made stylesheet and before the site's own rules", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/tickets")).text);
    const sheets = html.querySelectorAll("link[rel=stylesheet]").map((l) => l.getAttribute("href"));
    expect(sheets).toEqual(["/assets/pico.min.css", "/assets/theme.css", "/assets/site.css"]);
    expect(html.querySelector("html")?.getAttribute("data-theme")).toBe("light");
  });

  it("holds every colour: the site's own rules name none", () => {
    expect(site).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(site).not.toMatch(/rgba?\(/i);
  });

  it("never makes a status badge lime", () => {
    const badgeLines = theme.split("\n").filter((line) => line.includes("--pd-badge-"));
    expect(badgeLines.length).toBe(5);
    for (const line of badgeLines) {
      expect(line).not.toContain("accent");
      expect(line.toLowerCase()).not.toContain("#d1e935");
    }
  });

  it("serves Inter from this site", async () => {
    const { app } = buildTestApp();
    for (const weight of [400, 600, 700]) {
      const address = `/assets/inter/inter-latin-${weight}-normal.woff2`;
      expect(theme).toContain(`url("${address}")`);
      const res = await request(app).get(address);
      expect(res.status, address).toBe(200);
      expect(res.headers["content-type"]).toBe("font/woff2");
    }
  });
});

describe("the logo", () => {
  it("is the favicon and sits beside the name in the header, and is not the tick", async () => {
    const { app } = buildTestApp();
    const html = parse((await visitor(app).get("/sign-in")).text);
    expect(html.querySelector("link[rel=icon]")?.getAttribute("href")).toBe("/assets/brand.svg");
    expect(html.querySelector("header .brand img")?.getAttribute("src")).toBe("/assets/brand.svg");
    expect(
      html.querySelector("img[src='/assets/mark.svg'], link[href='/assets/mark.svg']"),
    ).toBeNull();
    const svg = await request(app).get("/assets/brand.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    // Neither the tick's lime nor its stroke: the tick belongs to the customer's Yes alone.
    const logo = fs.readFileSync("public/brand.svg", "utf8").toLowerCase();
    const lime = /fill="(#[0-9a-f]{6})"/i.exec(fs.readFileSync("public/mark.svg", "utf8"))![1]!;
    expect(logo).not.toContain(lime.toLowerCase());
    expect(logo).not.toContain("<path");
  });
});
