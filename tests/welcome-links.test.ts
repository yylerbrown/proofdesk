import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, SIGN_IN_ENV, visitor } from "./helpers.js";

// The page about the demo names where to read the source and where sign-in with roles runs.

function demo(env: NodeJS.ProcessEnv = {}) {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off", ...env });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}
const welcome = async (app: ReturnType<typeof demo>["app"]) =>
  parse((await visitor(app).get("/sign-in")).text);

describe("the page about the demo", () => {
  it("links Source and setup to the repository's README, when its address is set", async () => {
    const html = await welcome(demo({ SOURCE_URL: "https://code.example.com/team/desk/" }).app);
    const link = html.querySelector(".about-demo > .source-link a");
    expect(link?.text).toBe("Source and setup");
    expect(link?.getAttribute("href")).toBe("https://code.example.com/team/desk#readme");
    expect((await welcome(demo().app)).querySelector(".source-link")).toBeNull();
  });

  it("says the real site signs people in with GitHub, linking it and the README's section", async () => {
    const html = await welcome(
      demo({
        REAL_SITE_URL: "https://real.example.com",
        SOURCE_URL: "https://code.example.com/team/desk",
      }).app,
    );
    expect(html.querySelector(".real-site")?.text).toBe(
      "On the real site, people sign in with GitHub. Here you switch between three made-up people with Switch role at the top. How sign-in and roles work",
    );
    expect(
      html.querySelectorAll(".real-site a").map((a) => [a.text, a.getAttribute("href")]),
    ).toEqual([
      ["the real site", "https://real.example.com"],
      ["How sign-in and roles work", "https://code.example.com/team/desk#sign-in-and-roles"],
    ]);
    // Without a source address there is no README to point at, so the line ends there.
    const noSource = await welcome(demo({ REAL_SITE_URL: "https://real.example.com" }).app);
    expect(noSource.querySelector(".real-site")?.text).toBe(
      "On the real site, people sign in with GitHub. Here you switch between three made-up people with Switch role at the top.",
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
