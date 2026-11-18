import http from "node:http";
import type { AddressInfo } from "node:net";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { testUtils } from "better-auth/plugins";
import request from "supertest";
import { parse } from "node-html-parser";
import { describe, expect, it, vi } from "vitest";
import { FILING_LIMIT, SIGN_IN_LIMIT } from "../src/server/limits.js";
import { createAuth } from "../src/server/auth.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { loadConfig } from "../src/server/config.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  closeServers,
  customerOne,
  customerTwo,
  FROM_THIS_SITE,
  listenLocally,
  SIGN_IN_ENV,
  signedInLine,
  visitor,
} from "./helpers.js";

type TestDb = ReturnType<typeof buildTestApp>["db"];

const valid = { title: "Printer is broken", description: "It jams on every page." };
const ROLES = { ADMIN_GITHUB_IDS: "1001", TEAM_GITHUB_IDS: "2002,2003" };

/** An app with GitHub sign-in configured and the development entrance closed. */
function buildSignInApp(env: NodeJS.ProcessEnv = {}) {
  return buildTestApp({ ...SIGN_IN_ENV, ...ROLES, DEV_SIGN_IN: "off", ...env });
}

/**
 * Puts a person, their GitHub account and a session into the database, the way a finished
 * GitHub sign-in does, and returns the Cookie header of their browser. It uses the sign-in
 * library's own test helpers on a second instance that shares the database and the secret,
 * so the cookie is one the app's own instance accepts. Nothing here talks to GitHub.
 */
async function signedInBrowser(db: TestDb, githubId: string, name: string) {
  const testAuth = betterAuth({
    database: db,
    secret: SIGN_IN_ENV.BETTER_AUTH_SECRET,
    baseURL: SIGN_IN_ENV.BETTER_AUTH_URL,
    plugins: [testUtils()],
  });
  const test = (await testAuth.$context).test;
  const user = await test.saveUser(test.createUser({ name, email: `${githubId}@example.com` }));
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
     VALUES (?, ?, 'github', ?, ?, ?)`,
  ).run(`account-${githubId}`, githubId, user.id, now, now);
  const login = await test.login({ userId: user.id });
  return { userId: user.id, cookie: login.headers.get("cookie") ?? "" };
}

describe("the team list on a ticket page", () => {
  it("names everyone signed in as team or admin, read in one query however many there are", async () => {
    const { app, db } = buildSignInApp();
    const boss = await signedInBrowser(db, "1001", "Ada Admin");
    const customer = await signedInBrowser(db, "5005", "Sam Customer");
    await signedInBrowser(db, "2002", "Bo Team");
    await visitor(app).post("/api/tickets").set("Cookie", customer.cookie).send(valid);

    const prepare = vi.spyOn(db, "prepare");
    const accountQueries = () =>
      prepare.mock.calls.filter(([sql]) => String(sql).includes('"account"')).length;
    const handOffTo = async () => {
      const page = await request(app).get("/tickets/SUP-1").set("Cookie", boss.cookie);
      return parse(page.text)
        .querySelectorAll("form[action$='/hand-off'] option")
        .map((option) => option.text);
    };
    expect(await handOffTo()).toEqual(["Ada Admin", "Bo Team"]);
    const few = accountQueries();

    await signedInBrowser(db, "2003", "Cy Team");
    await signedInBrowser(db, "5006", "Di Customer");
    prepare.mockClear();
    expect(await handOffTo()).toEqual(["Ada Admin", "Bo Team", "Cy Team"]);
    // Two more people, and not one more query for them.
    expect(accountQueries()).toBe(few);
    prepare.mockRestore();
  });
});

describe("the development entrance beside GitHub sign-in", () => {
  // The entrance lets anyone pick who they are, the admin included, so a server that
  // signs real people in through GitHub must never offer it, whatever its mode.
  it.each(["development", "test"])("is refused in %s mode, with a clear message", (mode) => {
    expect(() => loadConfig({ ...SIGN_IN_ENV, NODE_ENV: mode, DEV_SIGN_IN: "on" })).toThrow(
      "Invalid environment configuration: DEV_SIGN_IN must not be on together with the " +
        "GitHub sign-in settings. It lets anyone act as an admin.",
    );
  });
});

describe("the sign-in library's tables", () => {
  it("are all created by our own migration, with nothing left for the library to add", async () => {
    const { db, config } = buildSignInApp();
    const wanted = await getMigrations(createAuth(db, config.signIn!, undefined).options);
    expect(wanted.toBeCreated).toEqual([]);
    expect(wanted.toBeAdded).toEqual([]);
  });
});

describe("a GitHub session", () => {
  it("signs the person in, and records them as the creator", async () => {
    const { app, db } = buildSignInApp();
    const browser = await signedInBrowser(db, "5005", "Sam Customer");

    const filed = await visitor(app).post("/api/tickets").set("Cookie", browser.cookie).send(valid);
    expect(filed.status).toBe(201);
    expect(filed.body.created_by).toBe(browser.userId);

    const page = await request(app).get("/tickets").set("Cookie", browser.cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain(signedInLine("Sam Customer", "customer"));
  });

  it("gives the role that the configuration names for the GitHub user number", async () => {
    const { app, db } = buildSignInApp();
    const boss = await signedInBrowser(db, "1001", "Ada Admin");
    const helper = await signedInBrowser(db, "2003", "Tom Team");
    const guest = await signedInBrowser(db, "9009", "Vic Visitor");
    await visitor(app).post("/api/tickets").set("Cookie", guest.cookie).send(valid);

    const signedInAs = async (cookie: string) =>
      (await request(app).get("/tickets").set("Cookie", cookie)).text;
    expect(await signedInAs(boss.cookie)).toContain(signedInLine("Ada Admin", "admin"));
    expect(await signedInAs(helper.cookie)).toContain(signedInLine("Tom Team", "team"));
    expect(await signedInAs(guest.cookie)).toContain(signedInLine("Vic Visitor", "customer"));

    const changeStatus = (cookie: string) =>
      visitor(app).patch("/api/tickets/SUP-1").set("Cookie", cookie).send({ status: "new" });
    expect((await changeStatus(guest.cookie)).status).toBe(403); // a customer cannot
    expect((await changeStatus(helper.cookie)).status).toBe(200); // a team member can
  });

  it("keeps two customers apart", async () => {
    const { app, db } = buildSignInApp();
    const one = await signedInBrowser(db, "5005", "Sam");
    const two = await signedInBrowser(db, "6006", "Kim");
    await visitor(app).post("/api/tickets").set("Cookie", one.cookie).send(valid);
    expect((await request(app).get("/api/tickets/SUP-1").set("Cookie", two.cookie)).status).toBe(
      404,
    );
    expect((await request(app).get("/api/tickets").set("Cookie", two.cookie)).body).toEqual([]);
  });

  it("is refused when the cookie was changed, and when there is none", async () => {
    const { app, db } = buildSignInApp();
    const browser = await signedInBrowser(db, "1001", "Ada Admin");
    // Change one character in the middle of the cookie value.
    const middle = Math.floor(browser.cookie.length / 2);
    const swapped = browser.cookie[middle] === "a" ? "b" : "a";
    const forged = browser.cookie.slice(0, middle) + swapped + browser.cookie.slice(middle + 1);

    expect((await request(app).get("/api/tickets").set("Cookie", forged)).status).toBe(401);
    expect((await request(app).get("/api/tickets")).status).toBe(401);
    expect((await request(app).get("/api/tickets").set("Cookie", browser.cookie)).status).toBe(200);
  });

  it("does not accept the development cookie when that entrance is closed", async () => {
    const { app } = buildSignInApp();
    expect((await admin(app).get("/api/tickets")).status).toBe(401);
  });

  it("ends at sign-out: the same cookie no longer works", async () => {
    const { app, db } = buildSignInApp();
    const browser = await signedInBrowser(db, "1001", "Ada Admin");
    const out = await visitor(app).post("/sign-out").set("Cookie", browser.cookie);
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe("/sign-in");
    expect((await request(app).get("/api/tickets").set("Cookie", browser.cookie)).status).toBe(401);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "session"`).get()).toEqual({ n: 0 });
  });
});

describe("starting a GitHub sign-in", () => {
  it("offers the button and sends the browser to GitHub with our callback address", async () => {
    const { app } = buildSignInApp();
    const page = await request(app).get("/sign-in");
    expect(page.text).toContain('action="/sign-in/github"');
    expect(page.text).not.toContain("Development entrance");

    const res = await visitor(app).post("/sign-in/github");
    expect(res.status).toBe(303);
    const target = new URL(res.headers.location as string);
    expect(target.origin + target.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(target.searchParams.get("client_id")).toBe("test-client-id");
    expect(target.searchParams.get("redirect_uri")).toBe(
      "http://desk.test/api/auth/callback/github",
    );
    expect(target.searchParams.get("scope")).toContain("user:email");
    // The secret never goes to the browser.
    expect(res.headers.location).not.toContain("test-client-secret");
    expect(String(res.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("asks GitHub for the email permission and nothing else", async () => {
    const { app } = buildSignInApp();
    const res = await visitor(app).post("/sign-in/github");
    const target = new URL(res.headers.location as string);
    expect(target.searchParams.get("scope")).toBe("user:email");
  });

  it("is not there when GitHub sign-in is not configured", async () => {
    const { app } = buildTestApp();
    expect((await request(app).get("/sign-in")).text).not.toContain('action="/sign-in/github"');
    expect((await visitor(app).post("/sign-in/github")).status).toBe(404);
    const res = await request(app).get("/api/auth/ok");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("allows only a few starts a minute from one address", async () => {
    const { app } = buildSignInApp();
    for (let i = 0; i < SIGN_IN_LIMIT; i++) {
      expect((await visitor(app).post("/sign-in/github")).status).toBe(303);
    }
    const res = await visitor(app).post("/sign-in/github");
    expect(res.status).toBe(429);
    expect(res.text).toContain("Too many requests.");
  });
});

// The sign-in library's own API. The app never uses it: it starts a sign-in, reads the session
// and signs out by calling the library directly. Each row is a route the library answers when
// it is given all of /api/auth, sent the way the library expects it.
const LIBRARY_ROUTES: [method: "get" | "post", path: string, body?: object][] = [
  ["post", "/api/auth/update-user", { name: "Ada Admin" }],
  ["post", "/api/auth/get-access-token", { providerId: "github" }],
  ["get", "/api/auth/list-sessions"],
  ["get", "/api/auth/get-session"],
  ["post", "/api/auth/sign-in/social", { provider: "github" }],
  ["get", "/api/auth/account-info"],
  ["post", "/api/auth/change-email", { newEmail: "someone@example.com" }],
  ["post", "/api/auth/revoke-sessions", {}],
  ["post", "/api/auth/link-social", { provider: "github" }],
  ["get", "/api/auth/list-accounts"],
  ["get", "/api/auth/ok"],
  ["get", "/api/auth/error"],
  ["post", "/api/auth/sign-out", {}],
  ["post", "/api/auth/callback/github", { provider: "github" }],
];

describe("the sign-in library's own routes", () => {
  it.each(LIBRARY_ROUTES)(
    "answer 404 to a signed-in customer and to a visitor: %s %s",
    async (method, path, body) => {
      const { app, db } = buildSignInApp();
      const customer = await signedInBrowser(db, "5005", "Sam Customer");
      for (const cookie of [customer.cookie, undefined]) {
        const req = visitor(app)[method](path);
        if (cookie !== undefined) req.set("Cookie", cookie);
        const res = body === undefined ? await req : await req.send(body);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("not_found");
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
      // Nothing changed and nothing started: the name is the one GitHub gave, the customer is
      // still signed in, and no sign-in is waiting for GitHub.
      expect(db.prepare(`SELECT "name" FROM "user"`).all()).toEqual([{ name: "Sam Customer" }]);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "session"`).get()).toEqual({ n: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM "verification"`).get()).toEqual({ n: 0 });
    },
  );

  // Express would also send these to the route of GitHub's return: it ignores letter case and a
  // trailing slash, and answers HEAD with a GET route. GitHub sends none of them.
  it.each([
    ["get", "/api/auth/callback/GitHub"],
    ["get", "/api/auth/callback/github/"],
    ["head", "/api/auth/callback/github"],
  ] as const)("answer 404 to GitHub's return sent another way: %s %s", async (method, path) => {
    const { app } = buildSignInApp();
    const res = await visitor(app)[method](path).query({ code: "made-up-code", state: "unknown" });
    // The app's own 404, which is JSON: the library was not asked.
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  // Each request says it carries 64 MB, and only its headers are sent. A server that read the
  // body before answering would wait for it and never answer.
  it.each([
    ["POST", "/api/auth/sign-in/social", 404],
    ["POST", "/api/auth/callback/github", 404],
    // GitHub's return, which the library answers. With no sign-in under way, it sends the
    // browser back to the sign-in page.
    ["GET", "/api/auth/callback/github", 302],
  ] as const)("answer %s %s before any of its body arrives", async (method, path, expected) => {
    const { app } = buildSignInApp();
    const server = await listenLocally(app);
    try {
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(64 * 1024 * 1024),
            ...FROM_THIS_SITE,
          },
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        });
        req.on("error", reject);
        req.setTimeout(4000, () => {
          req.destroy();
          reject(new Error(`No answer to ${method} ${path}: the server waited for the body.`));
        });
        req.flushHeaders();
      });
      expect(status).toBe(expected);
    } finally {
      await closeServers([server]);
    }
  });
});

describe("requests forged from another site", () => {
  // What a browser sends when a page on another site posts a form here.
  const foreign = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
  // The cookie of a signed-in admin, which a browser attaches no matter who made it ask.
  const cookie = `${DEV_COOKIE}=${adminActor.id}`;

  it.each([
    ["post", "/api/tickets"],
    ["put", "/api/tickets/SUP-1"],
    ["patch", "/api/tickets/SUP-1"],
    ["post", "/api/tickets/SUP-1/archive"],
    ["post", "/tickets"],
    ["post", "/tickets/SUP-1/edit"],
    ["post", "/tickets/SUP-1/status"],
    ["post", "/tickets/SUP-1/archive"],
    ["post", "/sign-out"],
    ["post", "/sign-in/dev"],
    ["post", "/sign-in/github"],
    ["post", "/api/tickets/SUP-1/restore"],
    ["post", "/tickets/SUP-1/restore"],
  ] as const)("are refused: %s %s", async (method, address) => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const before = await admin(app).get("/api/tickets/SUP-1");

    const type = address.startsWith("/api") ? "json" : "form";
    const body = { ...valid, title: "Forged", status: "resolved", id: customerOne.id };
    const res = await request(app)
      [method](address)
      .set("Cookie", cookie)
      .set(foreign)
      .type(type)
      .send(body);

    expect(res.status).toBe(403);
    if (type === "json") expect(res.body.error.code).toBe("cross_site_request");
    else expect(res.text).toContain("This request did not come from this site.");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect((await admin(app).get("/api/tickets/SUP-1")).body).toEqual(before.body);
    expect((await admin(app).get("/api/tickets")).body).toHaveLength(1);
  });

  it.each([
    ["only a foreign Origin", { Origin: "https://evil.example" }],
    ["an Origin of null", { Origin: "null" }],
    ["only the cross-site marker", { "Sec-Fetch-Site": "cross-site" }],
    ["a sibling site", { "Sec-Fetch-Site": "same-site" }],
    [
      "the cross-site marker and our own Origin",
      { Host: "desk.test", Origin: "http://desk.test", "Sec-Fetch-Site": "cross-site" },
    ],
    [
      "our host name inside a longer one",
      { Host: "desk.test", Origin: "http://desk.test.evil.example" },
    ],
    ["nothing that says where it comes from", {}],
  ])("are refused with %s", async (_name, headers) => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post("/api/tickets")
      .set("Cookie", cookie)
      .set(headers)
      .send(valid);
    expect(res.status).toBe(403);
    expect((await admin(app).get("/api/tickets")).body).toEqual([]);
  });

  it.each([
    [
      "this site's own form",
      { Host: "desk.test", Origin: "http://desk.test", "Sec-Fetch-Site": "same-origin" },
    ],
    // A browser blanks out Origin on a form when the page's referrer policy is strict.
    [
      "this site's own form with a blank Origin",
      { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    ],
    ["an older browser that sends only Origin", { Host: "desk.test", Origin: "http://desk.test" }],
    ["an address typed by the person", { "Sec-Fetch-Site": "none" }],
  ])("does not block %s", async (_name, headers) => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post("/api/tickets")
      .set("Cookie", cookie)
      .set(headers)
      .send(valid);
    expect(res.status).toBe(201);
  });

  it("compares Origin with the configured address, not with the Host header", async () => {
    // SIGN_IN_ENV says this site is http://desk.test. The development entrance is never open
    // beside GitHub sign-in, so an admin signed in through GitHub posts here.
    const { app, db } = buildSignInApp();
    const boss = await signedInBrowser(db, "1001", "Ada Admin");
    const post = (headers: Record<string, string>) =>
      request(app).post("/api/tickets").set("Cookie", boss.cookie).set(headers).send(valid);

    expect((await post({ Origin: "http://desk.test" })).status).toBe(201);
    // A Host header that agrees with a foreign Origin does not help.
    expect((await post({ Host: "evil.example", Origin: "http://evil.example" })).status).toBe(403);
    // The scheme counts too.
    expect((await post({ Origin: "https://desk.test" })).status).toBe(403);
  });

  it("does not block reading from another site, which changes nothing", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/tickets").set("Cookie", cookie).set(foreign);
    expect(res.status).toBe(200);
  });
});

describe("returning to the page that was asked for", () => {
  it("carries the address through the sign-in page and back", async () => {
    const { app } = buildTestApp();
    const sent = await visitor(app).get("/tickets/SUP-7?x=1");
    expect(sent.headers.location).toBe("/sign-in?next=%2Ftickets%2FSUP-7%3Fx%3D1");

    const page = await visitor(app).get(sent.headers.location as string);
    expect(page.text).toContain('name="next" value="/tickets/SUP-7?x=1"');

    const res = await visitor(app)
      .post("/sign-in/dev")
      .type("form")
      .send({ id: customerOne.id, next: "/tickets/SUP-7?x=1" });
    expect(res.headers.location).toBe("/tickets/SUP-7?x=1");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/\t/evil.example/",
    "/\n/evil.example/",
    "/tickets\u00a0",
    "evil.example",
    "javascript:alert(1)",
    "",
  ])("goes to the ticket list instead of %j", async (next) => {
    const { app } = buildTestApp();
    const res = await visitor(app)
      .post("/sign-in/dev")
      .type("form")
      .send({ id: customerOne.id, next });
    expect(res.headers.location).toBe("/tickets");
    const page = await visitor(app).get("/sign-in").query({ next });
    expect(page.text).toContain('name="next" value="/tickets"');
  });

  it("tells GitHub sign-in where to come back to", async () => {
    const { app, db } = buildSignInApp();
    await visitor(app).post("/sign-in/github").type("form").send({ next: "/tickets/SUP-7" });
    await visitor(app).post("/sign-in/github").type("form").send({ next: "https://evil.example/" });
    // The library keeps the return address with the sign-in it started.
    const kept = db.prepare(`SELECT "value" FROM "verification" ORDER BY "createdAt"`).all() as {
      value: string;
    }[];
    expect(kept).toHaveLength(2);
    expect(kept[0]!.value).toContain('"callbackURL":"/tickets/SUP-7"');
    expect(kept[1]!.value).toContain('"callbackURL":"/tickets"');
    expect(kept[1]!.value).not.toContain("evil.example");
  });
});

describe("the limit on filing tickets", () => {
  it("answers 429 after the limit, as JSON on the API, and stores nothing more", async () => {
    const { app } = buildTestApp();
    for (let i = 0; i < FILING_LIMIT; i++) {
      expect((await as(app, customerOne).post("/api/tickets").send(valid)).status).toBe(201);
    }
    const res = await as(app, customerOne).post("/api/tickets").send(valid);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("too_many_requests");
    expect((await as(app, customerOne).get("/api/tickets")).body).toHaveLength(FILING_LIMIT);
  });

  it("counts the form and the API together, and each person on their own", async () => {
    const { app } = buildTestApp();
    for (let i = 0; i < FILING_LIMIT; i++) {
      await as(app, customerOne).post("/tickets").type("form").send(valid);
    }
    const form = await as(app, customerOne).post("/tickets").type("form").send(valid);
    expect(form.status).toBe(429);
    expect(form.headers["content-type"]).toMatch(/html/);
    expect((await as(app, customerOne).post("/api/tickets").send(valid)).status).toBe(429);
    // Someone else is not held back by it.
    expect((await as(app, customerTwo).post("/api/tickets").send(valid)).status).toBe(201);
  });

  it("does not limit reading or editing", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    for (let i = 0; i < FILING_LIMIT + 5; i++) {
      expect((await admin(app).get("/api/tickets/SUP-1")).status).toBe(200);
      const edited = await admin(app)
        .put("/api/tickets/SUP-1")
        .send({ ...valid, title: `Edit number ${i}` });
      expect(edited.status).toBe(200);
    }
  });

  it("does not count refused tickets, so mistakes cannot lock a customer out", async () => {
    const { app } = buildTestApp();
    for (let i = 0; i < FILING_LIMIT + 5; i++) {
      const refused = await as(app, customerOne).post("/tickets").type("form").send({ title: "x" });
      expect(refused.status).toBe(400);
    }
    expect((await as(app, customerOne).post("/api/tickets").send(valid)).status).toBe(201);
  });
});

describe("the ticket's history", () => {
  it("shows each person's role beside their name, so a chosen name cannot pass as the team", async () => {
    const { app, db } = buildSignInApp();
    const customer = await signedInBrowser(db, "5005", "Proofdesk Support");
    const team = await signedInBrowser(db, "2002", "Bo Team");
    await visitor(app).post("/api/tickets").set("Cookie", customer.cookie).send(valid);
    await visitor(app).post("/api/tickets/SUP-1/take").set("Cookie", team.cookie);
    const page = await request(app).get("/tickets/SUP-1").set("Cookie", team.cookie);
    const rows = parse(page.text)
      .querySelectorAll("details.history tbody tr")
      .map((row) => row.querySelectorAll("td")[2]!);
    const who = rows.map((cell) => [
      cell.text.replace(cell.querySelector(".role-label")?.text ?? "", "").trim(),
      cell.querySelector(".role-label")?.text,
    ]);
    expect(who).toContainEqual(["Proofdesk Support", "customer"]);
    expect(who).toContainEqual(["Bo Team", "team"]);
  });
});
