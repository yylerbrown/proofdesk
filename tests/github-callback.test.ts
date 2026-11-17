import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestApp, PRODUCTION_SIGN_IN_ENV, SIGN_IN_ENV, visitor } from "./helpers.js";

type TestApp = ReturnType<typeof buildTestApp>["app"];
type GithubUser = { id: number; login: string; name: string; email: string };

// These tests run the whole GitHub sign-in: our start route, the library's return route,
// then a page. GitHub itself is replaced by a stand-in for the three addresses the library
// asks it, so nothing leaves this machine. The stand-in answers as the person set below.
let githubUser: GithubUser = { id: 0, login: "", name: "", email: "" };

beforeAll(() => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return json({ access_token: "made-up-token", token_type: "bearer", scope: "user:email" });
    }
    if (url === "https://api.github.com/user") return json({ ...githubUser, avatar_url: "" });
    if (url === "https://api.github.com/user/emails") {
      return json([{ email: githubUser.email, primary: true, verified: true }]);
    }
    return realFetch(input, init);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Cookie name=value pairs from a response, ready to send back. */
function cookiesOf(res: request.Response): string {
  const set = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
  return set.map((cookie) => cookie.split(";")[0]).join("; ");
}

/** Signs in through GitHub as `who`, the way a browser would, and returns where it ended up. */
async function signInThroughGithub(app: TestApp, who: GithubUser, next?: string) {
  githubUser = who;
  const start = await visitor(app)
    .post("/sign-in/github")
    .type("form")
    .send(next === undefined ? {} : { next });
  const state = new URL(start.headers.location as string).searchParams.get("state") ?? "";
  // GitHub sends the browser back to our callback address with a code and the same state.
  const back = await request(app)
    .get("/api/auth/callback/github")
    .query({ code: "made-up-code", state })
    .set("Cookie", cookiesOf(start));
  const cookie = cookiesOf(back);
  const page = await request(app).get("/tickets").set("Cookie", cookie);
  const signedInAs = /Signed in as ([^<]*?)\./.exec(page.text)?.[1] ?? null;
  return { location: back.headers.location as string, cookie, signedInAs };
}

const ada: GithubUser = { id: 1001, login: "ada", name: "Ada Admin", email: "ada@corp.example" };

function buildGithubApp() {
  return buildTestApp({ ...SIGN_IN_ENV, DEV_SIGN_IN: "off", ADMIN_GITHUB_IDS: "1001" });
}

describe("the whole GitHub sign-in", () => {
  it("signs a person in and stores their GitHub user number", async () => {
    const { app, db } = buildGithubApp();
    const result = await signInThroughGithub(app, ada);
    expect(result.location).toBe("/tickets");
    expect(result.signedInAs).toBe("Ada Admin (admin)");
    expect(db.prepare(`SELECT "accountId", "providerId" FROM "account"`).all()).toEqual([
      { accountId: "1001", providerId: "github" },
    ]);
  });

  it("does not let another GitHub account with the same email take over a person", async () => {
    const { app, db } = buildGithubApp();
    await signInThroughGithub(app, ada);
    // A different GitHub account that now shows Ada's verified email address.
    const other: GithubUser = { id: 7777, login: "someone", name: "Someone", email: ada.email };
    const result = await signInThroughGithub(app, other);

    expect(result.signedInAs).toBeNull();
    expect(result.location).toMatch(/^\/sign-in\?error=/);
    expect(db.prepare(`SELECT "accountId" FROM "account"`).all()).toEqual([{ accountId: "1001" }]);
    const page = await request(app).get(result.location);
    expect(page.text).toContain("That sign-in did not work.");
  });

  it("returns to the page that was asked for, and never to another site", async () => {
    const { app } = buildGithubApp();
    const back = await signInThroughGithub(app, ada, "/tickets/SUP-7");
    expect(back.location).toBe("/tickets/SUP-7");

    for (const next of ["/\t/evil.example/x", "/\n/evil.example/x", "//evil.example/x"]) {
      const sent = await signInThroughGithub(app, ada, next);
      expect(sent.location).toBe("/tickets");
    }
  });

  it("keeps the browser's cookie in step when the library extends a session in use", async () => {
    const { app, db } = buildGithubApp();
    const { cookie } = await signInThroughGithub(app, ada);
    // Make the session look two days old, so the library extends it on the next request.
    const twoDaysOld = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`UPDATE "session" SET "expiresAt" = ?`).run(twoDaysOld);

    const res = await request(app).get("/tickets").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain("better-auth.session_token=");
    const row = db.prepare(`SELECT "expiresAt" FROM "session"`).get() as { expiresAt: string };
    expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(new Date(twoDaysOld).getTime());
  });
});

describe("the session cookie in production", () => {
  it("is Secure and HttpOnly, and the GitHub token is not stored as it came", async () => {
    const { app, db } = buildTestApp({
      ...PRODUCTION_SIGN_IN_ENV,
      NODE_ENV: "production",
      ADMIN_GITHUB_IDS: "1001",
    });
    githubUser = ada;
    const start = await visitor(app).post("/sign-in/github");
    const state = new URL(start.headers.location as string).searchParams.get("state") ?? "";
    const back = await request(app)
      .get("/api/auth/callback/github")
      .query({ code: "made-up-code", state })
      .set("Cookie", cookiesOf(start));
    const session = ((back.headers["set-cookie"] as unknown as string[]) ?? []).find((cookie) =>
      cookie.includes("session_token="),
    );
    expect(session).toBeDefined();
    expect(session).toContain("Secure");
    expect(session).toContain("HttpOnly");

    const stored = db.prepare(`SELECT "accessToken" FROM "account"`).get() as {
      accessToken: string;
    };
    expect(stored.accessToken).not.toBe("made-up-token");
    expect(stored.accessToken).not.toContain("made-up-token");
  });
});

describe("when looking up the session fails", () => {
  it("still serves the stylesheets, which need no sign-in", async () => {
    const { app, db } = buildGithubApp();
    const { cookie } = await signInThroughGithub(app, ada);
    db.exec(`DROP TABLE "account"`);
    const res = await request(app).get("/assets/site.css").set("Cookie", cookie);
    expect(res.status).toBe(200);
  });

  it("answers the API in JSON and a page in HTML", async () => {
    const { app, db } = buildGithubApp();
    const { cookie } = await signInThroughGithub(app, ada);
    db.exec(`DROP TABLE "account"`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const api = await request(app).get("/api/tickets").set("Cookie", cookie);
    expect(api.status).toBe(500);
    expect(api.body.error.code).toBe("internal_error");

    const page = await request(app).get("/tickets").set("Cookie", cookie);
    expect(page.status).toBe(500);
    expect(page.headers["content-type"]).toMatch(/html/);
    log.mockRestore();
  });
});
