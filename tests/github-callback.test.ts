import { parse } from "node-html-parser";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  as,
  buildTestApp,
  customerOne,
  PRODUCTION_SIGN_IN_ENV,
  SIGN_IN_ENV,
  visitor,
} from "./helpers.js";

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
  const found = /<summary><strong>([^<]*)<\/strong> <small class="role-label">([^<]*)</.exec(
    page.text,
  );
  const signedInAs = found === null ? null : `${found[1]} (${(found[2] ?? "").toLowerCase()})`;
  return { location: back.headers.location as string, cookie, signedInAs };
}

/** The message at the top of the sign-in page, with how it is announced, or null. */
function noticeOf(html: string) {
  const notice = parse(html).querySelector(".sign-in-notice");
  return notice === null ? null : { role: notice.getAttribute("role"), text: notice.text };
}

const EXPIRED = "That sign-in expired before GitHub sent you back. Sign in again.";
const NO_VERIFIED_EMAIL =
  "GitHub did not share a verified email address for this account. Verify one on GitHub, then sign in again.";

/** Starts a GitHub sign-in and returns its state and the cookies the browser now holds. */
async function startGithubSignIn(app: TestApp, next?: string) {
  const start = await visitor(app)
    .post("/sign-in/github")
    .type("form")
    .send(next === undefined ? {} : { next });
  const state = new URL(start.headers.location as string).searchParams.get("state") ?? "";
  return { state, cookie: cookiesOf(start) };
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
    expect(result.location).toBe("/sign-in?error=account_not_linked");
    expect(db.prepare(`SELECT "accountId" FROM "account"`).all()).toEqual([{ accountId: "1001" }]);
    const page = await request(app).get(result.location);
    expect(noticeOf(page.text)).toEqual({
      role: "alert",
      text: "Your email address already belongs to a different GitHub account here. Sign in with that account.",
    });
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
    expect(landed.searchParams.get("error")).toBe("email_not_found");
    expect(noticeOf((await request(app).get(refused.location)).text)).toEqual({
      role: "alert",
      text: NO_VERIFIED_EMAIL,
    });
    for (const table of ["user", "account", "session"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get(), table).toEqual({ n: 0 });
    }

    // The address's owner, whose email GitHub has verified, signs in as usual.
    expect((await signInThroughGithub(app, ada)).signedInAs).toBe("Ada Admin (admin)");
  });

  it("answers an unverified address the same way whether or not it already has a person here", async () => {
    const { app, db } = buildGithubApp();
    await signInThroughGithub(app, ada);
    // One GitHub account shows Ada's address in other letter case, and another an unknown
    // address. GitHub has verified neither for them.
    const known: GithubUser = {
      id: 6666,
      login: "known",
      name: "Known",
      email: "ADA@corp.example",
      verified: false,
    };
    const unknown: GithubUser = {
      id: 6667,
      login: "unknown",
      name: "Unknown",
      email: "nobody@corp.example",
      verified: false,
    };
    const first = await signInThroughGithub(app, known);
    const second = await signInThroughGithub(app, unknown);

    expect(first.location).toBe("/sign-in?error=email_not_found");
    expect(second.location).toBe("/sign-in?error=email_not_found");
    const firstNotice = noticeOf((await request(app).get(first.location)).text);
    const secondNotice = noticeOf((await request(app).get(second.location)).text);
    expect(firstNotice).toEqual({ role: "alert", text: NO_VERIFIED_EMAIL });
    expect(secondNotice).toEqual(firstNotice);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "user"`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "account"`).get()).toEqual({ n: 1 });
    expect((await signInThroughGithub(app, ada)).signedInAs).toBe("Ada Admin (admin)");
  });

  it("still lets a returning person in when GitHub no longer calls their address verified", async () => {
    const { app } = buildGithubApp();
    await signInThroughGithub(app, ada);
    const result = await signInThroughGithub(app, { ...ada, verified: false });
    expect(result.location).toBe("/tickets");
    expect(result.signedInAs).toBe("Ada Admin (admin)");
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

  it("offers no second GitHub sign-in to someone already signed in", async () => {
    const { app } = buildGithubApp();
    const { cookie } = await signInThroughGithub(app, ada);
    const page = parse((await request(app).get("/sign-in").set("Cookie", cookie)).text);
    expect(page.querySelector(".signed-in")?.text).toContain("You are signed in as Ada Admin.");
    expect(page.querySelector("form[action='/sign-in/github']")).toBeNull();
    expect(page.querySelector(".github-reads")).toBeNull();
    expect(page.querySelector("h1")?.text).toBe("Proofdesk");
  });

  it("tells someone already signed in nothing about a failed sign-in, since there is nothing to try", async () => {
    const { app } = buildGithubApp();
    const { cookie } = await signInThroughGithub(app, ada);
    const address = "/sign-in?error=account_not_linked";
    expect(noticeOf((await request(app).get(address).set("Cookie", cookie)).text)).toBeNull();
    // A signed-out visitor at the same address is still told what went wrong.
    expect(noticeOf((await request(app).get(address)).text)?.role).toBe("alert");
  });

  it("ends a session seven days after sign-in, however recently it was used", async () => {
    const { app } = buildGithubApp();
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the browser to drop the cookie of a session that has ended", async () => {
    const { app, db } = buildGithubApp();
    const { cookie } = await signInThroughGithub(app, ada);
    const ended = new Date(Date.now() - 1000).toISOString();
    db.prepare(`UPDATE "session" SET "expiresAt" = ?`).run(ended);
    const res = await request(app).get("/tickets").set("Cookie", cookie);
    expect(res.status).toBe(303);
    expect(String(res.headers["set-cookie"])).toMatch(/better-auth\.session_token=;.*Max-Age=0/);
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
    "send a GitHub return with %s to the sign-in page, where someone signed in is not told to try again",
    async (_name, query, reason) => {
      const { app } = buildGithubApp();
      // Someone signed in already, as when a GitHub tab left open overnight comes back. They
      // are still signed in, so there is nothing to try again.
      const { cookie } = await signInThroughGithub(app, ada);
      const back = await request(app)
        .get("/api/auth/callback/github")
        .query(query)
        .set("Cookie", cookie);
      const landed = await landingOf(app, back.headers.location as string, cookie);
      expect(landed.url.pathname).toBe("/sign-in");
      expect(landed.url.searchParams.get("error")).toBe(reason);
      expect(noticeOf(landed.res.text)).toBeNull();
      expect(parse(landed.res.text).querySelector(".signed-in")?.text).toContain("Ada Admin");
    },
  );
});

describe("every way back from GitHub", () => {
  it("says a cancelled sign-in shared nothing, and then opens the ticket it started from", async () => {
    const { app } = buildGithubApp();
    const { state, cookie } = await startGithubSignIn(app, "/tickets/SUP-7");
    // On GitHub the visitor pressed Cancel, so GitHub sends them back with an error.
    const back = await request(app)
      .get("/api/auth/callback/github")
      .query({ error: "access_denied", error_description: "The user denied it", state })
      .set("Cookie", cookie);
    const landed = new URL(back.headers.location as string, SIGN_IN_ENV.BETTER_AUTH_URL);
    expect(landed.pathname).toBe("/sign-in");
    expect(landed.searchParams.get("error")).toBe("access_denied");

    const page = await request(app).get(landed.pathname + landed.search);
    expect(noticeOf(page.text)).toEqual({
      role: "alert",
      text: "You cancelled signing in with GitHub, so nothing was shared. Sign in again when you are ready.",
    });
    // GitHub's own description is never shown.
    expect(page.text).not.toContain("The user denied it");
    const next = parse(page.text).querySelector("form[action='/sign-in/github'] input[name=next]");
    expect(next?.getAttribute("value")).toBe("/tickets/SUP-7");

    // Signing in again from that page opens the ticket.
    const again = await signInThroughGithub(app, ada, "/tickets/SUP-7");
    expect(again.location).toBe("/tickets/SUP-7");
  });

  it("says a sign-in whose return was already used has expired", async () => {
    const { app } = buildGithubApp();
    githubUser = ada;
    const { state, cookie } = await startGithubSignIn(app);
    const callback = () =>
      request(app)
        .get("/api/auth/callback/github")
        .query({ code: "made-up-code", state })
        .set("Cookie", cookie);
    expect((await callback()).headers.location).toBe("/tickets");
    // The same return a second time, as from Back or a reload.
    const replayed = await callback();
    const landed = await landingOf(app, replayed.headers.location as string, "");
    expect(landed.url.searchParams.get("error")).toBe("state_mismatch");
    expect(noticeOf(landed.res.text)).toEqual({ role: "alert", text: EXPIRED });
  });

  it("names this site's callback address when GitHub refuses the return address", async () => {
    const { app } = buildGithubApp();
    const { state, cookie } = await startGithubSignIn(app);
    const back = await request(app)
      .get("/api/auth/callback/github")
      .query({ error: "redirect_uri_mismatch", state })
      .set("Cookie", cookie);
    const page = await request(app).get(back.headers.location as string);
    expect(noticeOf(page.text)).toEqual({
      role: "alert",
      text: "GitHub did not accept this site's return address. If you run this site, set your GitHub OAuth app's callback URL to http://desk.test/api/auth/callback/github.",
    });
  });

  it.each(["state_mismatch", "state_not_found", "state_invalid"])(
    "says %s means the sign-in expired",
    async (code) => {
      const { app } = buildGithubApp();
      const page = await request(app).get("/sign-in").query({ error: code });
      expect(noticeOf(page.text)).toEqual({ role: "alert", text: EXPIRED });
    },
  );

  it("shows any other code only when it is plain lowercase letters and underscores", async () => {
    const { app } = buildGithubApp();
    const plain = await request(app).get("/sign-in").query({ error: "invalid_code" });
    expect(noticeOf(plain.text)).toEqual({
      role: "alert",
      text: "GitHub sign-in did not finish. Sign in again. If it keeps failing, give the site's owner this code: invalid_code.",
    });

    const general = "GitHub sign-in did not finish. Sign in again.";
    for (const error of ["<b>bold</b>", "Invalid-Code", "two words", ["a", "b"]]) {
      const page = await request(app).get("/sign-in").query({ error });
      expect(noticeOf(page.text), String(error)).toEqual({ role: "alert", text: general });
      expect(page.text).not.toContain("<b>bold</b>");
    }
  });

  it("says once that a GitHub sign-out happened", async () => {
    const { app } = buildGithubApp();
    const { cookie } = await signInThroughGithub(app, ada);
    // One agent keeps cookies the way a browser does, so the second visit sends whatever
    // the sign-out and the first visit left behind.
    const browser = visitor(app);
    browser.jar.setCookies(cookie.split("; "));
    const out = await browser.post("/sign-out");
    expect(out.headers.location).toBe("/sign-in");
    expect(String(out.headers["set-cookie"])).toContain("sign_in_notice=signedOut");

    const first = await browser.get("/sign-in");
    expect(noticeOf(first.text)).toEqual({
      role: "status",
      text: "You are signed out. To sign in with a different GitHub account, sign out of GitHub first.",
    });
    const second = await browser.get("/sign-in");
    expect(noticeOf(second.text)).toBeNull();
  });

  it("says nothing about signing out when nobody was signed in", async () => {
    const { app } = buildGithubApp();
    const out = await visitor(app).post("/sign-out");
    expect(out.headers.location).toBe("/sign-in");
    expect(String(out.headers["set-cookie"])).not.toContain("sign_in_notice=");
  });

  it("says nothing about GitHub when a made-up person of the development entrance signs out", async () => {
    const { app } = buildTestApp();
    const out = await as(app, customerOne).post("/sign-out");
    expect(String(out.headers["set-cookie"])).not.toContain("sign_in_notice=");
  });

  it("shows no GitHub message from the address where there is no GitHub sign-in", async () => {
    const { app } = buildTestApp();
    const page = await request(app).get("/sign-in").query({ error: "access_denied" });
    expect(noticeOf(page.text)).toBeNull();
  });

  it("shows no message on a plain visit", async () => {
    const { app } = buildGithubApp();
    expect(noticeOf((await request(app).get("/sign-in")).text)).toBeNull();
  });
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
