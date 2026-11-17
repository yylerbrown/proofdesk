import { describe, expect, it, vi } from "vitest";
import { admin, buildTestApp } from "./helpers.js";

const valid = { title: "Printer is broken", description: "It jams on every page." };

/** Submits the ticket form the way a browser does: as form fields, not JSON. */
function submitForm(app: ReturnType<typeof buildTestApp>["app"], fields: Record<string, string>) {
  return admin(app).post("/tickets").type("form").send(fields);
}

describe("ticket list page", () => {
  it("redirects the home address to the list", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/tickets");
  });

  it("says so when there are no tickets", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("No tickets to show.");
  });

  it("shows each ticket with a link to its page, newest first", async () => {
    const { app } = buildTestApp();
    await submitForm(app, { ...valid, title: "First ticket" });
    await submitForm(app, { ...valid, title: "Second ticket" });
    const res = await admin(app).get("/tickets");
    expect(res.text).toContain('<a href="/tickets/SUP-1">SUP-1</a>');
    expect(res.text).toContain('<a href="/tickets/SUP-2">SUP-2</a>');
    expect(res.text.indexOf("Second ticket")).toBeLessThan(res.text.indexOf("First ticket"));
  });

  it("narrows the list with the status filter", async () => {
    const { app } = buildTestApp();
    await submitForm(app, { ...valid, title: "Still open" });
    await submitForm(app, { ...valid, title: "Already done" });
    await admin(app).patch("/api/tickets/SUP-2").send({ status: "resolved" });

    const resolved = await admin(app).get("/tickets?status=resolved");
    expect(resolved.text).toContain("Already done");
    expect(resolved.text).not.toContain("Still open");

    const fresh = await admin(app).get("/tickets?status=new");
    expect(fresh.text).toContain("Still open");
    expect(fresh.text).not.toContain("Already done");

    const all = await admin(app).get("/tickets?status=all");
    expect(all.text).toContain("Still open");
    expect(all.text).toContain("Already done");
  });

  it("marks the chosen filter as the current one", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets?status=in_progress");
    expect(res.text).toContain('href="/tickets?status=in_progress" aria-current="page"');
    expect(res.text).not.toContain('href="/tickets" aria-current="page"');
  });

  it("returns an HTML 400 page for an unknown status", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets?status=done");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("That request did not work");
  });
});

describe("new ticket form", () => {
  it("shows an empty form", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets/new");
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="post" action="/tickets">');
    expect(res.text).toContain("How will we know it's fixed?");
  });

  it("files a ticket, redirects to its page, and the JSON API returns the same ticket", async () => {
    const { app } = buildTestApp();
    const res = await submitForm(app, {
      ...valid,
      where_url: "https://example.com/print",
      fix_check: "Ten pages print without a jam.",
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets/SUP-1");

    const api = await admin(app).get("/api/tickets/SUP-1");
    expect(api.body).toMatchObject({
      key: "SUP-1",
      title: valid.title,
      description: valid.description,
      status: "new",
      where_url: "https://example.com/print",
      fix_check: "Ten pages print without a jam.",
    });
    const events = await admin(app).get("/api/tickets/SUP-1/events");
    expect(events.body.map((e: { type: string }) => e.type)).toEqual(["created"]);
  });

  it("stores the optional boxes as null when they are left empty", async () => {
    const { app } = buildTestApp();
    const res = await submitForm(app, { ...valid, where_url: "", fix_check: "" });
    expect(res.status).toBe(303);
    const api = await admin(app).get("/api/tickets/SUP-1");
    expect(api.body.where_url).toBeNull();
    expect(api.body.fix_check).toBeNull();
  });

  it("shows the form again with messages and what was typed, and files nothing", async () => {
    const { app } = buildTestApp();
    const res = await submitForm(app, {
      title: "ab",
      description: "A description worth keeping",
      where_url: "javascript:alert(1)",
      fix_check: "",
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain("Must be at least 3 characters.");
    expect(res.text).toContain("Must be a link that starts with http or https.");
    expect(res.text).toContain('value="ab"');
    expect(res.text).toContain("A description worth keeping</textarea>");

    const api = await admin(app).get("/api/tickets");
    expect(api.body).toEqual([]);
  });

  it("treats a form with no fields as an empty form, not a crash", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).post("/tickets");
    expect(res.status).toBe(400);
    expect(res.text).toContain("Must not be empty.");
  });
});

describe("ticket page", () => {
  it("shows the ticket, its optional fields and its history", async () => {
    const { app } = buildTestApp();
    await submitForm(app, {
      ...valid,
      where_url: "https://example.com/print",
      fix_check: "Ten pages print without a jam.",
    });
    const res = await admin(app).get("/tickets/SUP-1");
    expect(res.status).toBe(200);
    expect(res.text).toContain(valid.title);
    expect(res.text).toContain(valid.description);
    expect(res.text).toContain('href="https://example.com/print"');
    expect(res.text).toContain("Ten pages print without a jam.");
    expect(res.text).toContain("Ticket filed");
    expect(res.text).toContain("<td>dev-admin-1</td>");
    expect(res.text).toMatch(/<td>\d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC<\/td>/);
    expect(res.text).toContain('<option value="new" selected>New</option>');
  });

  it("returns an HTML 404 page for a ticket that does not exist", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets/SUP-999");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("No ticket SUP-999.");
  });

  it("returns an HTML 400 page for a malformed key", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets/SUP-abc");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("That request did not work");
  });
});

describe("status control", () => {
  it("changes the status, redirects back, and writes exactly one history entry", async () => {
    const { app } = buildTestApp();
    await submitForm(app, valid);

    const res = await admin(app)
      .post("/tickets/SUP-1/status")
      .type("form")
      .send({ status: "in_progress" });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets/SUP-1");

    const events = await admin(app).get("/api/tickets/SUP-1/events");
    expect(events.body).toHaveLength(2);
    expect(events.body[1]).toMatchObject({
      type: "status_changed",
      data: { from: "new", to: "in_progress" },
    });

    const page = await admin(app).get("/tickets/SUP-1");
    expect(page.text).toContain("Status changed from New to In Progress");
    expect(page.text).toContain('<option value="in_progress" selected>In Progress</option>');
  });

  it("writes no history entry when the status stays the same", async () => {
    const { app } = buildTestApp();
    await submitForm(app, valid);
    const res = await admin(app).post("/tickets/SUP-1/status").type("form").send({ status: "new" });
    expect(res.status).toBe(303);
    const events = await admin(app).get("/api/tickets/SUP-1/events");
    expect(events.body).toHaveLength(1);
  });

  it.each([{ status: "done" }, {}])("returns an HTML 400 page for %j", async (fields) => {
    const { app } = buildTestApp();
    await submitForm(app, valid);
    const res = await admin(app).post("/tickets/SUP-1/status").type("form").send(fields);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("That request did not work");
    const api = await admin(app).get("/api/tickets/SUP-1");
    expect(api.body.status).toBe("new");
  });

  it("returns an HTML 400 page when no form is sent at all", async () => {
    const { app } = buildTestApp();
    await submitForm(app, valid);
    const res = await admin(app).post("/tickets/SUP-1/status");
    expect(res.status).toBe(400);
    expect(res.text).toContain("That request did not work");
  });

  it("returns an HTML 404 page for a ticket that does not exist", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/tickets/SUP-999/status")
      .type("form")
      .send({ status: "resolved" });
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/html/);
  });
});

describe("ticket text is shown as text, never as markup", () => {
  const markup = '<script>alert("x")</script>';
  const escaped = "&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt;";

  it("escapes every field on the list and ticket pages", async () => {
    const { app } = buildTestApp();
    await submitForm(app, {
      title: `Title ${markup}`,
      description: `Description ${markup}`,
      where_url: `https://example.com/?q=${markup}`,
      fix_check: `Check ${markup}`,
    });

    const list = await admin(app).get("/tickets");
    expect(list.text).toContain(`Title ${escaped}`);
    expect(list.text).not.toContain("<script>");

    const page = await admin(app).get("/tickets/SUP-1");
    expect(page.status).toBe(200);
    expect(page.text).toContain(`Title ${escaped}`);
    expect(page.text).toContain(`Description ${escaped}`);
    expect(page.text).toContain(`Check ${escaped}`);
    expect(page.text).not.toContain("<script>");
  });

  it("escapes what was typed when the form is shown again", async () => {
    const { app } = buildTestApp();
    const res = await submitForm(app, {
      title: `"><script>alert(1)</script>`,
      description: "</textarea><script>alert(2)</script>",
      where_url: `"><script>alert(3)</script>`,
      fix_check: "</textarea><script>alert(4)</script>",
    });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("<script>");
  });

  it("escapes the key in an error page", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets/" + encodeURIComponent("<script>alert(1)</script>"));
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("<script>");
  });
});

describe("pages and the JSON API keep their own error formats", () => {
  it("returns an HTML 404 page for an unknown address", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("There is no page at this address.");
  });

  it("still returns JSON for an unknown API address and a malformed JSON body", async () => {
    const { app } = buildTestApp();
    const missing = await admin(app).get("/api/nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");

    const broken = await admin(app)
      .post("/api/tickets")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(broken.status).toBe(400);
    expect(broken.headers["content-type"]).toMatch(/json/);
  });

  it("still answers a form sent to the API with a JSON 400", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).post("/api/tickets").type("form").send(valid);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("answers an unexpected failure as JSON on the API and as HTML on a page, without details", async () => {
    const { app, db } = buildTestApp();
    db.close();
    // The failure is logged with console.error. Silence it so the test output stays clean.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const api = await admin(app).get("/api/tickets");
    expect(api.status).toBe(500);
    expect(api.body).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });

    const page = await admin(app).get("/tickets");
    expect(page.status).toBe(500);
    expect(page.headers["content-type"]).toMatch(/html/);
    expect(page.text).toContain("Something went wrong");
    expect(page.text).not.toContain("database");

    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});

describe("stylesheets", () => {
  it.each(["/assets/pico.min.css", "/assets/site.css"])("serves %s", async (address) => {
    const { app } = buildTestApp();
    const res = await admin(app).get(address);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/css/);
  });
});
