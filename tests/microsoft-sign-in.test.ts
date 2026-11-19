import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { parse } from "node-html-parser";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { SIGN_IN_LIMIT } from "../src/server/limits.js";
import { buildTestApp, FROM_THIS_SITE, SIGN_IN_ENV, visitor } from "./helpers.js";

type TestApp = ReturnType<typeof buildTestApp>["app"];

// These tests run the whole Microsoft sign-in: our start route, the library's return route,
// then a page. Microsoft itself is replaced by a stand-in for the two addresses the library
// asks it, its token address and its signing keys, so nothing leaves this machine. GitHub is
// replaced too, for the people who sign in that way beside them.

const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-8888-4777-8666-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AUTHORITY = "https://login.microsoftonline.com";

const MICROSOFT_ENV = {
  ...SIGN_IN_ENV,
  DEV_SIGN_IN: "off",
  ADMIN_GITHUB_IDS: "1001",
  MICROSOFT_CLIENT_ID: CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: "made-up-microsoft-secret",
  MICROSOFT_TENANT_ID: TENANT,
};

/** Microsoft's signing key, and another that Microsoft never published. */
const microsoftKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** A Microsoft account as the stand-in shows it, with what its ID token says. */
type MicrosoftUser = {
  oid: string;
  name: string;
  email?: string;
  /** Claims of the ID token to set or replace, such as another tenant's tid. */
  claims?: Record<string, unknown>;
  /** The key the token is signed with. Microsoft's own unless a test says otherwise. */
  signedWith?: KeyObject;
};

let microsoftUser: MicrosoftUser = { oid: "", name: "" };
let githubUser = { id: 0, login: "", name: "", email: "" };
/** What the app sent to Microsoft's token address, and any address it should never call. */
let tokenRequests: URLSearchParams[] = [];
let unexpected: string[] = [];

/** base64url, as a JSON Web Token writes each part. */
function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An ID token for the current Microsoft user, signed the way Microsoft signs one. */
function idTokenFor(user: MicrosoftUser): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `${AUTHORITY}/${TENANT}/v2.0`,
    aud: CLIENT_ID,
    sub: `sub-${user.oid}`,
    oid: user.oid,
    tid: TENANT,
    iat: now,
    nbf: now,
    exp: now + 3600,
    name: user.name,
    preferred_username: user.email ?? `${user.oid}@corp.example`,
    ...(user.email === undefined ? {} : { email: user.email, xms_edov: true }),
    ...user.claims,
  };
  const signed = `${part({ alg: "RS256", kid: "key-1", typ: "JWT" })}.${part(claims)}`;
  const signature = sign("sha256", Buffer.from(signed), user.signedWith ?? microsoftKey.privateKey);
  return `${signed}.${signature.toString("base64url")}`;
}

beforeAll(() => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url === `${AUTHORITY}/${TENANT}/oauth2/v2.0/token`) {
      tokenRequests.push(new URLSearchParams(String(init?.body ?? "")));
      return json({
        access_token: "made-up-access-token",
        id_token: idTokenFor(microsoftUser),
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url === `${AUTHORITY}/${TENANT}/discovery/v2.0/keys`) {
      const key = microsoftKey.publicKey.export({ format: "jwk" });
      return json({ keys: [{ ...key, kid: "key-1", use: "sig", kty: "RSA" }] });
    }
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return json({ access_token: "made-up-token", token_type: "bearer", scope: "user:email" });
    }
    if (url === "https://api.github.com/user") {
      const { id, login, name, email } = githubUser;
      return json({ id, login, name, email, avatar_url: "" });
    }
    if (url === "https://api.github.com/user/emails") {
      return json([{ email: githubUser.email, primary: true, verified: true }]);
    }
    if (url.includes("microsoft") || url.includes("github")) {
      unexpected.push(url);
      return new Response("not offered", { status: 404 });
    }
    return realFetch(input, init);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  tokenRequests = [];
  unexpected = [];
});

/** Cookie name=value pairs from a response, ready to send back. */
function cookiesOf(res: request.Response): string {
  const set = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
  return set.map((cookie) => cookie.split(";")[0]).join("; ");
}

/** Who the header says is signed in, such as "Ada Admin (admin)", or null. */
async function signedInAs(app: TestApp, cookie: string): Promise<string | null> {
  const page = await request(app).get("/tickets").set("Cookie", cookie);
  const found = /<summary><strong>([^<]*)<\/strong> <small class="role-label">([^<]*)</.exec(
    page.text,
  );
  return found === null ? null : `${found[1]} (${(found[2] ?? "").toLowerCase()})`;
}

/** Starts a Microsoft sign-in and returns where it sends the browser, and its cookies. */
async function startMicrosoftSignIn(app: TestApp, next?: string) {
  const start = await visitor(app)
    .post("/sign-in/microsoft")
    .type("form")
    .send(next === undefined ? {} : { next });
  expect(start.status).toBe(303);
  const goTo = new URL(start.headers.location as string);
  return { goTo, state: goTo.searchParams.get("state") ?? "", cookie: cookiesOf(start) };
}

/** Signs in through Microsoft as `who`, the way a browser would. */
async function signInThroughMicrosoft(app: TestApp, who: MicrosoftUser, next?: string) {
  microsoftUser = who;
  const { state, cookie } = await startMicrosoftSignIn(app, next);
  // Microsoft sends the browser back to our return address with a code and the same state.
  const back = await request(app)
    .get("/api/auth/callback/microsoft")
    .query({ code: "made-up-code", state })
    .set("Cookie", cookie);
  const session = cookiesOf(back);
  return {
    location: back.headers.location as string,
    cookie: session,
    signedInAs: await signedInAs(app, session),
  };
}

/** Signs in through GitHub as `who`. */
async function signInThroughGithub(app: TestApp, who: typeof githubUser) {
  githubUser = who;
  const start = await visitor(app).post("/sign-in/github").type("form").send({});
  const state = new URL(start.headers.location as string).searchParams.get("state") ?? "";
  const back = await request(app)
    .get("/api/auth/callback/github")
    .query({ code: "made-up-code", state })
    .set("Cookie", cookiesOf(start));
  const cookie = cookiesOf(back);
  return { location: back.headers.location as string, cookie };
}

/** The message at the top of the sign-in page, with how it is announced, or null. */
function noticeOf(html: string) {
  const notice = parse(html).querySelector(".sign-in-notice");
  return notice === null ? null : { role: notice.getAttribute("role"), text: notice.text };
}

function count(db: ReturnType<typeof buildTestApp>["db"], table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

const mia: MicrosoftUser = { oid: "oid-mia", name: "Mia Microsoft", email: "mia@corp.example" };
const ada = { id: 1001, login: "ada", name: "Ada Admin", email: "ada@corp.example" };

const ADDRESS_TAKEN =
  "Your email address already belongs to a different account here. Sign in with the account you used before.";
const NO_EMAIL =
  "Microsoft did not share a verified email address for this account. Ask whoever runs this site or your organization's Microsoft accounts, then sign in again.";

function buildMicrosoftApp() {
  return buildTestApp(MICROSOFT_ENV);
}

describe("Microsoft sign-in settings", () => {
  it("are read as a set of three, beside GitHub's", () => {
    expect(loadConfig(MICROSOFT_ENV).signIn?.microsoft).toEqual({
      clientId: CLIENT_ID,
      clientSecret: "made-up-microsoft-secret",
      tenantId: TENANT,
    });
    expect(() => loadConfig({ ...MICROSOFT_ENV, MICROSOFT_CLIENT_SECRET: "" })).toThrow(
      /also set MICROSOFT_CLIENT_SECRET/,
    );
    const alone = {
      MICROSOFT_CLIENT_ID: CLIENT_ID,
      MICROSOFT_CLIENT_SECRET: "made-up-microsoft-secret",
      MICROSOFT_TENANT_ID: TENANT,
    };
    expect(() => loadConfig(alone)).toThrow(/offered beside GitHub sign-in/);
  });

  it("take one tenant's id, never a shared tenant that lets any organization in", () => {
    for (const tenant of ["common", "organizations", "consumers", "corp.example"]) {
      expect(() => loadConfig({ ...MICROSOFT_ENV, MICROSOFT_TENANT_ID: tenant }), tenant).toThrow(
        /MICROSOFT_TENANT_ID: must be the Directory \(tenant\) ID/,
      );
    }
    const upper = loadConfig({ ...MICROSOFT_ENV, MICROSOFT_TENANT_ID: TENANT.toUpperCase() });
    expect(upper.signIn?.microsoft?.tenantId).toBe(TENANT);
  });
});

describe("without the Microsoft settings", () => {
  it("offers no Microsoft button, start, return or form address", async () => {
    const { app } = buildTestApp({ ...SIGN_IN_ENV, DEV_SIGN_IN: "off", ADMIN_GITHUB_IDS: "1001" });
    const page = await request(app).get("/sign-in");
    expect(parse(page.text).querySelector("form[action='/sign-in/microsoft']")).toBeNull();
    expect(page.text).not.toContain("Microsoft");
    expect(page.headers["content-security-policy"]).toContain(
      "form-action 'self' https://github.com;",
    );
    expect((await visitor(app).post("/sign-in/microsoft")).status).toBe(404);
    const back = await request(app).get("/api/auth/callback/microsoft").query({ code: "x" });
    expect(back.status).toBe(404);
  });
});

describe("the sign-in page with both ways in", () => {
  it("shows one button for each, and says what each shares", async () => {
    const { app } = buildMicrosoftApp();
    const page = parse((await request(app).get("/sign-in")).text);
    const buttons = page.querySelectorAll("form button").map((button) => button.text);
    expect(buttons).toEqual(["Sign in with GitHub", "Sign in with Microsoft"]);
    expect(page.querySelector(".github-reads")?.text).toBe(
      "Anyone with a GitHub account, or a Microsoft account at this organization, can sign in. Proofdesk reads your name and email address, and your picture from GitHub, never your files, mail or code.",
    );
    // Microsoft's mark is drawn from a file this server serves, like GitHub's.
    expect(page.querySelector("form[action='/sign-in/microsoft'] .microsoft-mark")).not.toBeNull();
    expect((await request(app).get("/assets/microsoft-mark.svg")).status).toBe(200);
  });
});

describe("the sign-in page's protections with both ways in", () => {
  it("lets its forms go to this server, GitHub and Microsoft's sign-in page, and nowhere else", async () => {
    const { app } = buildMicrosoftApp();
    const page = await request(app).get("/sign-in");
    const policy = String(page.headers["content-security-policy"]).split(";");
    expect(
      policy.map((rule) => rule.trim()).filter((rule) => rule.startsWith("form-action")),
    ).toEqual(["form-action 'self' https://github.com https://login.microsoftonline.com"]);
  });

  it("allows only a few Microsoft starts a minute from one address", async () => {
    const { app } = buildMicrosoftApp();
    for (let i = 0; i < SIGN_IN_LIMIT; i++) {
      expect((await visitor(app).post("/sign-in/microsoft")).status).toBe(303);
    }
    const res = await visitor(app).post("/sign-in/microsoft");
    expect(res.status).toBe(429);
    expect(res.text).toContain("Too many requests.");
  });
});

describe("the whole Microsoft sign-in", () => {
  it("asks this tenant only for who the person is, with PKCE, and makes them a customer", async () => {
    const { app, db } = buildMicrosoftApp();
    microsoftUser = mia;
    const { goTo, state, cookie } = await startMicrosoftSignIn(app);
    expect(goTo.origin + goTo.pathname).toBe(`${AUTHORITY}/${TENANT}/oauth2/v2.0/authorize`);
    expect(goTo.searchParams.get("scope")).toBe("openid profile email");
    expect(goTo.searchParams.get("redirect_uri")).toBe(
      "http://desk.test/api/auth/callback/microsoft",
    );
    expect(goTo.searchParams.get("code_challenge_method")).toBe("S256");

    const back = await request(app)
      .get("/api/auth/callback/microsoft")
      .query({ code: "made-up-code", state })
      .set("Cookie", cookie);
    expect(back.headers.location).toBe("/tickets");
    expect(await signedInAs(app, cookiesOf(back))).toBe("Mia Microsoft (customer)");

    // The code went back with the verifier that matches the challenge sent first.
    const verifier = tokenRequests[0]?.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(goTo.searchParams.get("code_challenge"));
    expect(db.prepare(`SELECT "providerId", "accountId" FROM "account"`).all()).toEqual([
      { providerId: "microsoft", accountId: "oid-mia" },
    ]);
    // No token is kept, and nothing else at Microsoft is asked, such as a profile picture.
    expect(
      db.prepare(`SELECT "accessToken", "refreshToken", "idToken" FROM "account"`).get(),
    ).toEqual({ accessToken: null, refreshToken: null, idToken: null });
    expect(unexpected).toEqual([]);
  });

  it("refuses a return with a missing or wrong state, and signs nobody in", async () => {
    const { app, db } = buildMicrosoftApp();
    microsoftUser = mia;
    const { cookie } = await startMicrosoftSignIn(app);
    for (const query of [{ code: "made-up-code" }, { code: "made-up-code", state: "wrong" }]) {
      const back = await request(app)
        .get("/api/auth/callback/microsoft")
        .query(query)
        .set("Cookie", cookie);
      expect(String(back.headers["set-cookie"] ?? "")).not.toContain("session_token=");
    }
    expect(count(db, "session")).toBe(0);
    expect(tokenRequests).toEqual([]);
  });

  it.each([
    ["another tenant", { tid: OTHER_TENANT, iss: `${AUTHORITY}/${OTHER_TENANT}/v2.0` }],
    ["the configured issuer with another tenant's id", { tid: OTHER_TENANT }],
    ["another app", { aud: "00000000-0000-4000-8000-000000000000" }],
    ["an hour that has passed", { iat: 1_000_000, nbf: 1_000_000, exp: 1_003_600 }],
  ])("signs nobody in with an ID token from %s", async (_case, claims) => {
    const { app, db } = buildMicrosoftApp();
    const result = await signInThroughMicrosoft(app, { ...mia, claims });
    expect(result.signedInAs).toBeNull();
    expect(result.location).toBe("/sign-in?via=microsoft&error=unable_to_get_user_info");
    expect(count(db, "user")).toBe(0);
    expect(noticeOf((await request(app).get(result.location)).text)).toEqual({
      role: "alert",
      text: "Microsoft sign-in did not finish. Sign in again. If it keeps failing, give the site's owner this code: unable_to_get_user_info.",
    });
  });

  it("signs nobody in with an ID token Microsoft did not sign", async () => {
    const { app, db } = buildMicrosoftApp();
    const forged = { ...mia, signedWith: strangerKey.privateKey };
    const result = await signInThroughMicrosoft(app, forged);
    expect(result.signedInAs).toBeNull();
    expect(count(db, "user")).toBe(0);
  });

  it("refuses an email address Microsoft has not verified, before anyone is created", async () => {
    const { app, db } = buildMicrosoftApp();
    const unverified = { ...mia, claims: { xms_edov: false } };
    const result = await signInThroughMicrosoft(app, unverified);
    expect(result.signedInAs).toBeNull();
    expect(result.location).toBe("/sign-in?via=microsoft&error=email_not_found");
    expect(noticeOf((await request(app).get(result.location)).text)).toEqual({
      role: "alert",
      text: NO_EMAIL,
    });
    for (const table of ["user", "account", "session"]) expect(count(db, table), table).toBe(0);

    // An address Microsoft lists as verified is accepted, without the domain claim.
    const listed = { ...mia, claims: { xms_edov: false, verified_primary_email: [mia.email] } };
    expect((await signInThroughMicrosoft(app, listed)).signedInAs).toBe("Mia Microsoft (customer)");
  });

  it("still lets a returning person in when Microsoft no longer calls their address verified", async () => {
    const { app, db } = buildMicrosoftApp();
    expect((await signInThroughMicrosoft(app, mia)).signedInAs).toBe("Mia Microsoft (customer)");
    const unverified = { ...mia, claims: { xms_edov: false } };
    expect((await signInThroughMicrosoft(app, unverified)).signedInAs).toBe(
      "Mia Microsoft (customer)",
    );
    // A newcomer with the same answer from Microsoft is still refused.
    const newcomer = { oid: "oid-new", name: "New", email: "new@corp.example" };
    const refused = await signInThroughMicrosoft(app, { ...newcomer, claims: { xms_edov: false } });
    expect(refused.signedInAs).toBeNull();
    expect(refused.location).toBe("/sign-in?via=microsoft&error=email_not_found");
    expect(count(db, "user")).toBe(1);
  });

  it("keeps at most 100 characters of a Microsoft name, and the sign-in name when it is empty", async () => {
    const { app } = buildMicrosoftApp();
    const long = { oid: "oid-long", name: "N".repeat(150), email: "long@corp.example" };
    expect((await signInThroughMicrosoft(app, long)).signedInAs).toBe(
      `${"N".repeat(100)} (customer)`,
    );
    const nameless = { oid: "oid-nameless", name: "  ", email: "nameless@corp.example" };
    expect((await signInThroughMicrosoft(app, nameless)).signedInAs).toBe(
      "nameless@corp.example (customer)",
    );
  });

  it("never links a Microsoft account to a person who signed in with GitHub, or back", async () => {
    const { app, db } = buildMicrosoftApp();
    await signInThroughGithub(app, ada);
    // A Microsoft account with Ada's address.
    const sameAddress = { oid: "oid-other", name: "Other", email: ada.email };
    const result = await signInThroughMicrosoft(app, sameAddress);
    expect(result.signedInAs).toBeNull();
    expect(result.location).toBe("/sign-in?via=microsoft&error=account_not_linked");
    expect(noticeOf((await request(app).get(result.location)).text)).toEqual({
      role: "alert",
      text: ADDRESS_TAKEN,
    });

    // And a GitHub account with the address of someone who signed in with Microsoft.
    await signInThroughMicrosoft(app, mia);
    const github = await signInThroughGithub(app, { ...ada, id: 2002, email: "mia@corp.example" });
    expect(github.location).toBe("/sign-in?via=github&error=account_not_linked");
    expect(noticeOf((await request(app).get(github.location)).text)?.text).toBe(ADDRESS_TAKEN);
    expect(db.prepare(`SELECT "providerId", "accountId" FROM "account"`).all()).toEqual([
      { providerId: "github", accountId: "1001" },
      { providerId: "microsoft", accountId: "oid-mia" },
    ]);
  });

  it("ends a session seven days after sign-in, however recently it was used", async () => {
    const { app } = buildMicrosoftApp();
    const day = 24 * 60 * 60 * 1000;
    const signedInAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: signedInAt });
    try {
      const { cookie } = await signInThroughMicrosoft(app, mia);
      const openTickets = () => request(app).get("/tickets").set("Cookie", cookie);
      vi.setSystemTime(signedInAt + 7 * day - 60 * 1000);
      expect((await openTickets()).status).toBe(200);
      vi.setSystemTime(signedInAt + 7 * day + 60 * 1000);
      expect((await openTickets()).headers.location).toBe("/sign-in?next=%2Ftickets");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("every way back from Microsoft", () => {
  it("says a cancelled sign-in shared nothing, and keeps the page it started from", async () => {
    const { app } = buildMicrosoftApp();
    const { state, cookie } = await startMicrosoftSignIn(app, "/tickets/SUP-7");
    const back = await request(app)
      .get("/api/auth/callback/microsoft")
      .query({ error: "access_denied", error_description: "The user said no", state })
      .set("Cookie", cookie);
    const page = await request(app).get(back.headers.location as string);
    expect(noticeOf(page.text)).toEqual({
      role: "alert",
      text: "You cancelled signing in with Microsoft, so nothing was shared. Sign in again when you are ready.",
    });
    expect(page.text).not.toContain("The user said no");
    const next = parse(page.text).querySelector("form[action='/sign-in/microsoft'] input");
    expect(next?.getAttribute("value")).toBe("/tickets/SUP-7");
  });

  it("names neither way when a return has lost its sign-in", async () => {
    const { app } = buildMicrosoftApp();
    const back = await request(app)
      .get("/api/auth/callback/microsoft")
      .query({ code: "made-up-code", state: "unknown" });
    const landed = new URL(back.headers.location as string);
    expect(landed.pathname).toBe("/sign-in");
    const page = await request(app).get(landed.pathname + landed.search);
    expect(noticeOf(page.text)).toEqual({
      role: "alert",
      text: "That sign-in expired before you were sent back. Sign in again.",
    });
  });

  it("says once that a Microsoft sign-out happened", async () => {
    const { app } = buildMicrosoftApp();
    const { cookie } = await signInThroughMicrosoft(app, mia);
    const browser = visitor(app);
    browser.jar.setCookies(cookie.split("; "));
    await browser.post("/sign-out");
    expect(noticeOf((await browser.get("/sign-in")).text)).toEqual({
      role: "status",
      text: "You are signed out. To sign in with a different Microsoft account, sign out of Microsoft first.",
    });
  });
});

describe("only the two returns reach the sign-in library", () => {
  it("answers 404 to its other addresses and to near misses of Microsoft's return", async () => {
    const { app } = buildMicrosoftApp();
    const misses = [
      request(app).post("/api/auth/sign-in/social").send({ provider: "microsoft" }),
      request(app).get("/api/auth/callback/microsoft/"),
      request(app).get("/api/auth/CALLBACK/microsoft"),
      request(app).post("/api/auth/callback/microsoft").send({ code: "x" }),
    ];
    for (const miss of misses) expect((await miss).status).toBe(404);
  });
});

describe("roles for people who sign in with Microsoft", () => {
  it("lets an admin make them a team member on the People page, which says how each signed in", async () => {
    const { app } = buildMicrosoftApp();
    const admin = await signInThroughGithub(app, ada);
    const signedIn = await signInThroughMicrosoft(app, mia);
    const boss = visitor(app).set("Cookie", admin.cookie);

    const before = parse((await boss.get("/people")).text);
    const ways = before.querySelectorAll(".person-way").map((cell) => cell.text);
    expect(ways).toEqual(["GitHub", "Microsoft"]);
    const miaId = before.querySelectorAll("input[name=person]")[0]?.getAttribute("value") ?? "";
    // The admin named in the settings is locked; Mia's role can be chosen.
    expect(before.querySelectorAll("input[name=person]")).toHaveLength(1);

    const saved = await boss.post("/people").type("form").send({ person: miaId, role: "team" });
    expect(saved.status).toBe(303);
    expect(await signedInAs(app, signedIn.cookie)).toBe("Mia Microsoft (team member)");
  });
});

describe("a site with GitHub sign-in alone", () => {
  it("does not say how each person signed in, on People or the account page", async () => {
    const { app } = buildTestApp({ ...SIGN_IN_ENV, DEV_SIGN_IN: "off", ADMIN_GITHUB_IDS: "1001" });
    const admin = await signInThroughGithub(app, ada);
    const grace = { id: 2002, login: "grace", name: "Grace", email: "grace@corp.example" };
    await signInThroughGithub(app, grace);

    const people = parse((await visitor(app).set("Cookie", admin.cookie).get("/people")).text);
    expect(people.querySelectorAll(".person-name").map((cell) => cell.text)).toHaveLength(2);
    expect(people.querySelectorAll(".person-way")).toEqual([]);

    const account = parse(
      (await request(app).get("/account").set("Cookie", admin.cookie).set(FROM_THIS_SITE)).text,
    );
    expect(account.querySelector(".account-email")?.text).toBe(ada.email);
    expect(account.querySelector(".account-way")).toBeNull();
    expect(account.text).not.toContain("Signed in with");
  });
});
