import { describe, expect, it } from "vitest";
import { admin, buildTestApp, visitor } from "./helpers.js";

const valid = { title: "Printer is broken", description: "It jams on every page." };

function submitForm(app: ReturnType<typeof buildTestApp>["app"], fields: Record<string, string>) {
  return admin(app).post("/tickets").type("form").send(fields);
}

/** Splits a Content-Security-Policy header into { directive: "its values" }. */
function parsePolicy(header: string): Record<string, string> {
  const policy: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [name, ...values] = part.trim().split(" ");
    if (name) policy[name] = values.join(" ");
  }
  return policy;
}

describe("security headers", () => {
  it.each(["/tickets", "/api/health", "/nope"])("sends them on %s", async (address) => {
    const { app } = buildTestApp();
    const res = await admin(app).get(address);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("same-origin");
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("allows scripts and styles only from this server, and no inline script", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets");
    const policy = parsePolicy(res.headers["content-security-policy"] as string);
    expect(policy["default-src"]).toBe("'self'");
    expect(policy["script-src"]).toBe("'self'");
    expect(policy["script-src-attr"]).toBe("'none'");
    expect(policy["style-src"]).toBe("'self'");
    expect(policy["form-action"]).toBe("'self' https://github.com");
    expect(policy["frame-ancestors"]).toBe("'self'");
    expect(policy["object-src"]).toBe("'none'");
  });

  it("tells browsers to use only HTTPS for this site, in production", async () => {
    const res = await visitor(buildTestApp({ NODE_ENV: "production" }).app).get("/tickets");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  });

  it("tells browsers to switch to HTTPS in production only", async () => {
    const development = await admin(buildTestApp().app).get("/tickets");
    expect(development.headers["content-security-policy"]).not.toContain(
      "upgrade-insecure-requests",
    );
    const production = await visitor(buildTestApp({ NODE_ENV: "production" }).app).get("/tickets");
    expect(production.headers["content-security-policy"]).toContain("upgrade-insecure-requests");
  });

  it("has no inline script or inline style in any page, so the policy blocks nothing", async () => {
    const { app } = buildTestApp();
    await submitForm(app, valid);
    await admin(app).post("/tickets/SUP-1/archive");
    const pages = [
      "/tickets",
      "/tickets/new",
      "/tickets/SUP-1",
      "/tickets/SUP-1/edit",
      "/tickets/SUP-9",
      "/tickets?status=archived",
    ];
    for (const address of pages) {
      const res = await admin(app).get(address);
      if (res.status === 200) expect(res.text, address).toContain(OWN_SCRIPT);
      expect(withoutOwnScript(res.text), address).not.toMatch(/<script/i);
      expect(res.text, address).not.toMatch(/<style/i);
      expect(res.text, address).not.toMatch(/\sstyle=/i);
      expect(res.text, address).not.toMatch(/\son[a-z]+=/i);
    }
  });
});

describe("request size limit", () => {
  const tooBig = "a".repeat(101 * 1024);

  it("refuses a JSON body over the limit with a JSON 413 and stores nothing", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/api/tickets")
      .send({ ...valid, description: tooBig });
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.error.code).toBe("bad_request");
    expect((await admin(app).get("/api/tickets")).body).toEqual([]);
  });

  it("refuses a form over the limit with an HTML 413 and stores nothing", async () => {
    const { app } = buildTestApp();
    const res = await submitForm(app, { ...valid, description: tooBig });
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect((await admin(app).get("/api/tickets")).body).toEqual([]);
  });

  it("accepts the largest valid ticket, which is far under the limit", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/api/tickets")
      .send({
        title: "a".repeat(120),
        description: "a".repeat(5000),
        where_url: "https://example.com/" + "a".repeat(480),
        fix_check: "a".repeat(500),
      });
    expect(res.status).toBe(201);
  });
});

describe("fields a caller must not control", () => {
  const extras = {
    status: "resolved",
    created_by: "someone-else",
    owner_id: "someone-else",
    agent_id: "some-agent",
    archived_at: "2026-01-01T00:00:00.000Z",
    actor: "someone-else",
    actor_kind: "agent",
    key: "SUP-99",
    id: "99",
    created_at: "2000-01-01T00:00:00.000Z",
  };
  const untouched = {
    key: "SUP-1",
    status: "new",
    created_by: "dev-admin-1",
    owner_id: null,
    agent_id: null,
    archived_at: null,
  };

  it("are ignored when a ticket is filed through the API", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/api/tickets")
      .send({ ...valid, ...extras });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject(untouched);
    expect(res.body.created_at).not.toBe(extras.created_at);

    const events = await admin(app).get("/api/tickets/SUP-1/events");
    expect(events.body).toHaveLength(1);
    expect(events.body[0]).toMatchObject({ actor: "dev-admin-1", actor_kind: "person" });
  });

  it("are ignored when a ticket is filed through the form", async () => {
    const { app } = buildTestApp();
    const res = await submitForm(app, { ...valid, ...extras });
    expect(res.status).toBe(303);
    const ticket = await admin(app).get("/api/tickets/SUP-1");
    expect(ticket.body).toMatchObject(untouched);
  });

  it("are ignored when a ticket is edited or its status is changed", async () => {
    const { app } = buildTestApp();
    await submitForm(app, valid);

    await admin(app)
      .put("/api/tickets/SUP-1")
      .send({ ...valid, title: "A new title", ...extras });
    await admin(app).post("/api/tickets/SUP-1/take");
    await admin(app)
      .patch("/api/tickets/SUP-1")
      .send({ ...extras, status: "in_progress" });

    const ticket = await admin(app).get("/api/tickets/SUP-1");
    expect(ticket.body).toMatchObject({
      ...untouched,
      status: "in_progress",
      owner_id: "dev-admin-1",
    });
    const events = await admin(app).get("/api/tickets/SUP-1/events");
    for (const event of events.body) {
      expect(event).toMatchObject({ actor: "dev-admin-1", actor_kind: "person" });
    }
  });
});

// Every statement in the repository binds its values with ? or @name, so hostile text is
// stored as text. The first test below proves that. The two after it check that the list
// filter and the key are refused before any SQL runs; they would pass even with SQL built
// from strings, so they are about validation, not about how SQL is written.
describe("SQL injection", () => {
  const attack = "x'); DROP TABLE tickets; --";

  it("stores hostile text as plain text and leaves the tables alone", async () => {
    const { app, db } = buildTestApp();
    await submitForm(app, { title: attack, description: attack, fix_check: attack });
    await admin(app)
      .put("/api/tickets/SUP-1")
      .send({ title: `${attack} 2`, description: attack });

    const ticket = await admin(app).get("/api/tickets/SUP-1");
    expect(ticket.body).toMatchObject({ title: `${attack} 2`, description: attack });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get()).toEqual({ n: 2 });
  });

  it.each(["new' OR '1'='1", "new; DROP TABLE tickets", "new--"])(
    "refuses the list filter %j",
    async (status) => {
      const { app } = buildTestApp();
      await submitForm(app, valid);
      const res = await admin(app).get("/api/tickets").query({ status });
      expect(res.status).toBe(400);
      expect((await admin(app).get("/api/tickets")).body).toHaveLength(1);
    },
  );

  it.each(["SUP-1 OR 1=1", "SUP-1;--", "SUP-1'"])("refuses the key %j", async (key) => {
    const { app } = buildTestApp();
    await submitForm(app, valid);
    const res = await admin(app).get(`/api/tickets/${encodeURIComponent(key)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_key");
  });
});

// The one script tag the pages carry: a file from this site that shows times in local time.
const OWN_SCRIPT = '<script type="module" src="/assets/js/local-time.js"></script>';

// The one image tag: the mark beside the name in the header.
const OWN_MARK = '<img src="/assets/mark.svg" alt="" width="24" height="24" />';

/** A page without its own script and mark tags, so that any other such tag stands out. */
function withoutOwnScript(html: string): string {
  return html.replace(OWN_SCRIPT, "").replace(OWN_MARK, "");
}

describe("script injection in pages", () => {
  // Each of these would do something if a page ever printed it as markup.
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "</td></tr></table><h1>gone</h1>",
    '" onmouseover="alert(1)',
    "</textarea><script>alert(1)</script>",
    "<svg/onload=alert(1)>",
  ];

  it.each(hostile)("shows %j as text on every page that prints ticket text", async (text) => {
    const { app } = buildTestApp();
    const filed = await submitForm(app, {
      title: `T ${text}`,
      description: `D ${text}`,
      where_url: `https://example.com/?q=${text}`,
      fix_check: `C ${text}`,
    });
    // The link box refuses some of these outright. File without it then, so the other
    // three fields are still checked.
    const linkAccepted = filed.status === 303;
    if (!linkAccepted) {
      const again = await submitForm(app, {
        title: `T ${text}`,
        description: `D ${text}`,
        fix_check: `C ${text}`,
      });
      expect(again.status).toBe(303);
    }
    await admin(app)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({
        title: `T2 ${text}`,
        description: `D2 ${text}`,
        fix_check: `C2 ${text}`,
        // Keep the hostile link through the edit, so the pages below still show it.
        where_url: linkAccepted ? `https://example.com/?q=${text}` : "",
      });
    if (linkAccepted) {
      const page = await admin(app).get("/tickets/SUP-1");
      expect(page.text).toContain('href="https://example.com/?q=');
      const form = await admin(app).get("/tickets/SUP-1/edit");
      expect(form.text).toContain('name="where_url" value="https://example.com/?q=');
    }

    const pages = ["/tickets", "/tickets/SUP-1", "/tickets/SUP-1/edit"];
    for (const address of pages) {
      const res = await admin(app).get(address);
      expect(res.status, address).toBe(200);
      expect(res.text, address).toContain("T2 ");
      // No tag and no attribute from the hostile text may appear as markup.
      expect(withoutOwnScript(res.text), address).not.toMatch(/<(script|img|svg)\b/i);
      expect(res.text, address).not.toContain("<h1>gone");
      // A quote from the text must not end an attribute and start a new one.
      expect(res.text, address).not.toContain('" onmouseover=');
    }
  });

  it("never turns a link that is not http or https into a clickable link", async () => {
    const { app } = buildTestApp();
    for (const link of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      const res = await submitForm(app, { ...valid, where_url: link });
      expect(res.status).toBe(400);
    }
    expect((await admin(app).get("/api/tickets")).body).toEqual([]);
  });

  it("keeps a quote in a link inside the href", async () => {
    const { app } = buildTestApp();
    const res = await submitForm(app, {
      ...valid,
      where_url: 'https://example.com/"onmouseover="alert(1)',
    });
    expect(res.status).toBe(303);
    const page = await admin(app).get("/tickets/SUP-1");
    expect(page.text).toContain('href="https://example.com/&#34;onmouseover=&#34;alert(1)"');
  });
});

describe("what a browser keeps", () => {
  it("is nothing from a signed-in page or answer", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send({ title: "Printer jams", description: "x" });
    for (const address of ["/tickets/SUP-1", "/api/tickets/SUP-1", "/api/tickets"]) {
      const res = await admin(app).get(address);
      expect(res.headers["cache-control"], address).toBe("no-store");
    }
    // The stylesheets are the same for everyone and may be kept.
    const css = await visitor(app).get("/assets/site.css");
    expect(css.headers["cache-control"]).not.toBe("no-store");
  });
});
