import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, SIGN_IN_ENV, visitor } from "./helpers.js";

// The welcome page names where to read the source and where sign-in with roles runs, and the
// team's ticket page points at a real assistant's work beside connecting one.

function demo(env: NodeJS.ProcessEnv = {}) {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off", ...env });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}
const welcome = async (app: ReturnType<typeof demo>["app"]) =>
  parse((await visitor(app).get("/sign-in")).text);

describe("the demo's welcome", () => {
  it("links Source and setup to the repository's README beside the workflow, when its address is set", async () => {
    const html = await welcome(demo({ SOURCE_URL: "https://code.example.com/team/desk/" }).app);
    const link = html.querySelector("form.try-workflow + .try-steps + .source-link a");
    expect(link?.text).toBe("Source and setup");
    expect(link?.getAttribute("href")).toBe("https://code.example.com/team/desk#readme");
    expect((await welcome(demo().app)).querySelector(".source-link")).toBeNull();
  });

  it("says where GitHub sign-in with roles runs, linking the real site", async () => {
    const html = await welcome(demo({ REAL_SITE_URL: "https://real.example.com" }).app);
    expect(html.querySelector(".real-site")?.text).toBe(
      "GitHub sign-in with roles runs on the real site: real.example.com",
    );
    expect(html.querySelector(".real-site a")?.getAttribute("href")).toBe(
      "https://real.example.com",
    );
    // The real site itself does not point at itself.
    const real = buildTestApp({ ...SIGN_IN_ENV, REAL_SITE_URL: "https://real.example.com" });
    expect(
      parse((await visitor(real.app).get("/sign-in")).text).querySelector(".real-site"),
    ).toBeNull();
  });

  it("is told the real site's address and the public source by the demo's settings", () => {
    const flyToml = fs.readFileSync("fly.toml", "utf8");
    expect(flyToml).toContain('REAL_SITE_URL = "https://proofdesk.fly.dev"');
    expect(flyToml).toContain('SOURCE_URL = "https://github.com/yylerbrown/proofdesk"');
    expect(fs.readFileSync("fly.proofdesk.toml", "utf8")).toContain(
      'SOURCE_URL = "https://github.com/yylerbrown/proofdesk"',
    );
  });
});

describe("the team's ticket page", () => {
  it("offers a real assistant's work beside connecting one", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x", fix_check: "Ten pages print" });
    const prompt = parse((await admin(app).get("/tickets/SUP-1")).text).querySelector(
      ".spec-prompt",
    )!;
    expect(prompt.querySelectorAll("a").map((a) => [a.text, a.getAttribute("href")])).toEqual([
      ["Connect your assistant", "/connections"],
      ["See an assistant's work", "/assistant-run"],
    ]);
  });
});
