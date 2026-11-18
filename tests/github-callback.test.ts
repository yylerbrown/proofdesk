import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestApp, PRODUCTION_SIGN_IN_ENV, SIGN_IN_ENV, visitor } from "./helpers.js";

type TestApp = ReturnType<typeof buildTestApp>["app"];
/** A GitHub account as the stand-in shows it. Its email is verified unless it says false. */
type GithubUser = { id: number; login: string; name: string; email: string; verified?: boolean };

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
      // GitHub also gives a refresh token when its tokens are set to expire.
      return json({
        access_token: "made-up-token",
        refresh_token: "made-up-refresh-token",
        token_type: "bearer",
        scope: "user:email",
      });
    }
    const { id, login, name, email, verified = true } = githubUser;
    if (url === "https://api.github.com/user") {
      return json({ id, login, name, email, avatar_url: "" });
    }
    if (url === "https://api.github.com/user/emails") {
      return json([{ email, primary: true, verified }]);
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
  const found = /Signed in as <strong>([^<]*)<\/strong> <small class="role-label">([^<]*)</.exec(
    page.text,
  );
  const signedInAs = found === null ? null : `${found[1]} (${found[2]})`;
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

  it("refuses an email GitHub has not verified before anyone is created, so its owner still gets in", async () => {
    const { app, db } = buildGithubApp();
    // Another GitHub account showing Ada's address, which GitHub has not verified for it.
    const pretender: GithubUser = {
      id: 6666,
      login: "pretender",
      name: "Pretender",
      email: ada.email,
      verified: false,
    };
    const refused = await signInThroughGithub(app, pretender);

    expect(refused.signedInAs).toBeNull();
    const landed = new URL(refused.location, "http://desk.test");
    expect(landed.pathname).toBe("/sign-in");
    expect(landed.searchParams.get("error")).toBe("email_not_verified");
    expect((await request(app).get(refused.location)).text).toContain("That sign-in did not work.");
    for (const table of ["user", "account", "session"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get(), table).toEqual({ n: 0 });
    }

    // The address's owner, whose email GitHub has verified, signs in as usual.
    expect((await signInThroughGithub(app, ada)).signedInAs).toBe("Ada Admin (admin)");
  });

  it("keeps at most 100 characters of a GitHub name, and never half of one", async () => {
    const { app, db } = buildGithubApp();
    const long: GithubUser = { id: 4001, login: "long", name: "N".repeat(5000), email: "a@x.test" };
    expect((await signInThroughGithub(app, long)).signedInAs).toBe(`${"N".repeat(100)} (customer)`);
    // A character that takes two places in a JavaScript string, right at the cut.
    const wide = "W".repeat(99) + "\u{1F600}" + "W";
    const emoji: GithubUser = { id: 4002, login: "wide", name: wide, email: "b@x.test" };
    await signInThroughGithub(app, emoji);
    expect(db.prepare(`SELECT "name" FROM "user" ORDER BY "email"`).all()).toEqual([
      { name: "N".repeat(100) },
      { name: "W".repeat(99) + "\u{1F600}" },
    ]);
  });

  // Each of these is one character to a reader, made of several joined together.
  it.each([
    ["a flag", "\u{1F1E8}\u{1F1E6}"],
    ["an emoji with a skin tone", "\u{1F44D}\u{1F3FD}"],
    ["a family emoji", "\u{1F469}‍\u{1F469}‍\u{1F467}"],
    ["a keycap", "1️⃣"],
  ])("keeps %s whole when it is the 100th character of a GitHub name", async (_case, joined) => {
    const { app, db } = buildGithubApp();
    const name = "W".repeat(99) + joined + "W";
    await signInThroughGithub(app, { id: 4005, login: "joined", name, email: "d@x.test" });
    expect(db.prepare(`SELECT "name" FROM "user"`).get()).toEqual({
      name: "W".repeat(99) + joined,
    });
  });

  it.each([
    ["empty", ""],
    ["only spaces", "   "],
  ])("shows the GitHub login when the GitHub name is %s", async (_case, name) => {
    const { app } = buildGithubApp();
    const quiet: GithubUser = { id: 4003, login: "quiet-one", name, email: "c@x.test" };
    expect((await signInThroughGithub(app, quiet)).signedInAs).toBe("quiet-one (customer)");
  });

  it("keeps none of GitHub's tokens, at the first sign-in or a later one", async () => {
    const { app, db } = buildGithubApp();
    for (const signIn of ["first", "second"]) {
      expect((await signInThroughGithub(app, ada)).signedInAs, signIn).toBe("Ada Admin (admin)");
      const kept = db.prepare(`SELECT "accessToken", "refreshToken", "idToken" FROM "account"`);
      expect(kept.all(), signIn).toEqual([
        { accessToken: null, refreshToken: null, idToken: null },
      ]);
    }
  });

  it("drops a GitHub token that an earlier version stored, at the person's next sign-in", async () => {
    const { app, db } = buildGithubApp();
    await signInThroughGithub(app, ada);
    db.prepare(
      `UPDATE "account" SET "accessToken" = 'stored-earlier', "refreshToken" = 'too'`,
    ).run();
    await signInThroughGithub(app, ada);
    expect(db.prepare(`SELECT "accessToken", "refreshToken" FROM "account"`).get()).toEqual({
      accessToken: null,
      refreshToken: null,
    });
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

  it("ends a session seven days after sign-in, however recently it was used", async () => {
    const { app, db } = buildGithubApp();
    const day = 24 * 60 * 60 * 1000;
    const signedInAt = Date.now();
    // Only the clock is faked, so the requests themselves run as usual.
    vi.useFakeTimers({ toFake: ["Date"], now: signedInAt });
    try {
      const { cookie } = await signInThroughGithub(app, ada);
      const openTickets = () => request(app).get("/tickets").set("Cookie", cookie);
      // Used on the sixth day, and again a minute before the seventh is over.
      for (const usedAt of [6 * day, 7 * day - 60 * 1000]) {
        vi.setSystemTime(signedInAt + usedAt);
        expect((await openTickets()).status).toBe(200);
      }

      vi.setSystemTime(signedInAt + 7 * day + 60 * 1000);
      const res = await openTickets();
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe("/sign-in?next=%2Ftickets");
      // The browser is told to drop its cookie, and the session is gone from the database.
      expect(String(res.headers["set-cookie"])).toMatch(/better-auth\.session_token=;.*Max-Age=0/);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "session"`).get()).toEqual({ n: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the session cookie in production", () => {
  it("is Secure and HttpOnly, and GitHub's tokens are not kept", async () => {
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

    expect(db.prepare(`SELECT "accessToken", "refreshToken" FROM "account"`).get()).toEqual({
      accessToken: null,
      refreshToken: null,
    });
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

describe("the sign-in library's own routes", () => {
  it("refuse a GitHub return with a missing or wrong state, and sign nobody in", async () => {
    const { app, db } = buildGithubApp();
    githubUser = ada;
    for (const query of [{ code: "made-up-code" }, { code: "made-up-code", state: "wrong" }]) {
      const back = await request(app).get("/api/auth/callback/github").query(query);
      expect(String(back.headers["set-cookie"] ?? "")).not.toContain("session_token=");
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "session"`).get()).toEqual({ n: 0 });
  });

  it.each([
    ["no state", { code: "made-up-code" }, "state_not_found"],
    ["a state it never gave out", { code: "made-up-code", state: "unknown" }, "state_mismatch"],
  ])(
    "send a GitHub return with %s to the sign-in page with its reason, not to the tickets",
    async (_name, query, reason) => {
      const { app } = buildGithubApp();
      // Someone signed in already, as when a GitHub tab left open overnight comes back.
      const { cookie } = await signInThroughGithub(app, ada);
      const back = await request(app)
        .get("/api/auth/callback/github")
        .query(query)
        .set("Cookie", cookie);
      const landed = await landingOf(app, back.headers.location as string, cookie);
      expect(landed.url.pathname).toBe("/sign-in");
      expect(landed.url.searchParams.get("error")).toBe(reason);
      expect(landed.res.text).toContain("That sign-in did not work.");
    },
  );
});

/**
 * Follows redirects the way a browser would, as long as they stay on this site, and returns
 * the address it stopped at with its answer. Nothing is ever sent to another site.
 */
async function landingOf(app: TestApp, location: string, cookie: string) {
  const site = SIGN_IN_ENV.BETTER_AUTH_URL;
  let url = new URL(location, site);
  for (let hops = 0; hops < 5; hops++) {
    if (url.origin !== site) throw new Error(`A redirect left the site: ${url.href}`);
    const res = await request(app)
      .get(url.pathname + url.search)
      .set("Cookie", cookie);
    if (res.status < 300 || res.status >= 400) return { url, res };
    url = new URL(res.headers.location as string, url);
  }
  throw new Error(`Still redirecting after five hops, at ${url.href}`);
}
