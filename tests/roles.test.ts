import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import {
  admin,
  as,
  buildTestApp,
  visitor,
  customerOne,
  customerTwo,
  teamActor,
} from "./helpers.js";

const valid = { title: "Printer is broken", description: "It jams on every page." };

/** An app where customer one has filed SUP-1 and customer two has filed SUP-2. */
async function twoCustomers() {
  const built = buildTestApp();
  await as(built.app, customerOne)
    .post("/api/tickets")
    .send({ ...valid, title: "Ticket of one" });
  await as(built.app, customerTwo)
    .post("/api/tickets")
    .send({ ...valid, title: "Ticket of two" });
  return built;
}

describe("nobody signed in", () => {
  it.each([
    ["get", "/api/tickets"],
    ["post", "/api/tickets"],
    ["get", "/api/tickets/SUP-1"],
    ["patch", "/api/tickets/SUP-1"],
    ["put", "/api/tickets/SUP-1"],
    ["post", "/api/tickets/SUP-1/archive"],
    ["post", "/api/tickets/SUP-1/restore"],
    ["get", "/api/tickets/SUP-1/events"],
  ] as const)("the API answers %s %s with 401", async (method, address) => {
    const { app } = await twoCustomers();
    const res = await visitor(app)[method](address).send(valid);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("not_signed_in");
  });

  it.each([
    ["get", "/tickets"],
    ["get", "/tickets/new"],
    ["post", "/tickets"],
    ["get", "/tickets/SUP-1"],
    ["get", "/tickets/SUP-1/edit"],
    ["post", "/tickets/SUP-1/edit"],
    ["post", "/tickets/SUP-1/status"],
    ["post", "/tickets/SUP-1/archive"],
    ["post", "/tickets/SUP-1/restore"],
  ] as const)("the page %s %s sends the browser to sign in", async (method, address) => {
    const { app } = await twoCustomers();
    const res = await visitor(app)[method](address).type("form").send(valid);
    expect(res.status).toBe(303);
    // Opening a page remembers its address. A form post does not.
    const expected = method === "get" ? `/sign-in?next=${encodeURIComponent(address)}` : "/sign-in";
    expect(res.headers.location).toBe(expected);
  });

  it("changes nothing", async () => {
    const { app } = await twoCustomers();
    await visitor(app).post("/api/tickets").send(valid);
    await visitor(app).post("/tickets").type("form").send(valid);
    await visitor(app).post("/api/tickets/SUP-1/archive");
    const list = await admin(app).get("/api/tickets");
    expect(list.body.map((t: { key: string }) => t.key)).toEqual(["SUP-2", "SUP-1"]);
  });

  it("keeps the health address open", async () => {
    const { app } = buildTestApp();
    expect((await visitor(app).get("/api/health")).status).toBe(200);
  });
});

describe("who is acting comes only from the sign-in cookie", () => {
  it("records the signed-in person as the creator and on the event", async () => {
    const { app } = await twoCustomers();
    const ticket = await admin(app).get("/api/tickets/SUP-1");
    expect(ticket.body.created_by).toBe(customerOne.id);
    const events = await admin(app).get("/api/tickets/SUP-1/events");
    expect(events.body[0]).toMatchObject({ actor: customerOne.id, actor_kind: "person" });
  });

  it("ignores request fields that name someone else", async () => {
    const { app } = buildTestApp();
    const res = await as(app, customerOne)
      .post("/api/tickets?actor=dev-admin-1&role=admin")
      .send({ ...valid, actor: "dev-admin-1", role: "admin", created_by: customerTwo.id });
    expect(res.body.created_by).toBe(customerOne.id);
    // Still a customer: the archived list is for an admin.
    const archived = await as(app, customerOne).get("/api/tickets?status=archived&role=admin");
    expect(archived.status).toBe(403);
  });

  it("treats an unknown person in the cookie as nobody", async () => {
    const { app } = buildTestApp();
    const res = await visitor(app).get("/api/tickets").set("Cookie", `${DEV_COOKIE}=dev-owner-1`);
    expect(res.status).toBe(401);
  });

  it("ignores the cookie when the development entrance is off", async () => {
    const { app } = buildTestApp({ DEV_SIGN_IN: "off" });
    const res = await visitor(app).get("/api/tickets").set("Cookie", `${DEV_COOKIE}=dev-admin-1`);
    expect(res.status).toBe(401);
  });
});

describe("a customer", () => {
  it("lists only their own tickets, on the API and on the page", async () => {
    const { app } = await twoCustomers();
    const api = await as(app, customerOne).get("/api/tickets");
    expect(api.body.map((t: { key: string }) => t.key)).toEqual(["SUP-1"]);
    const filtered = await as(app, customerOne).get("/api/tickets?status=new");
    expect(filtered.body.map((t: { key: string }) => t.key)).toEqual(["SUP-1"]);

    const page = await as(app, customerOne).get("/tickets");
    expect(page.text).toContain("Ticket of one");
    expect(page.text).not.toContain("Ticket of two");
  });

  it.each([
    ["get", "/api/tickets/SUP-2"],
    ["get", "/api/tickets/SUP-2/events"],
    ["put", "/api/tickets/SUP-2"],
    ["patch", "/api/tickets/SUP-2"],
    ["post", "/api/tickets/SUP-2/archive"],
    ["post", "/api/tickets/SUP-2/restore"],
    ["get", "/tickets/SUP-2"],
    ["get", "/tickets/SUP-2/edit"],
    ["post", "/tickets/SUP-2/edit"],
    ["post", "/tickets/SUP-2/status"],
    ["post", "/tickets/SUP-2/archive"],
  ] as const)(
    "gets the same 404 for another customer's ticket as for no ticket: %s %s",
    async (method, address) => {
      const { app } = await twoCustomers();
      const body = { ...valid, title: "Taken over", status: "resolved" };
      // Pages take a form and the API takes JSON.
      const type = address.startsWith("/api") ? "json" : "form";
      const theirs = await as(app, customerOne)[method](address).type(type).send(body);
      const missing = await as(app, customerOne)
        [method](address.replace("SUP-2", "SUP-99"))
        .type(type)
        .send(body);
      expect(theirs.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(theirs.text.replaceAll("SUP-2", "X")).toBe(missing.text.replaceAll("SUP-99", "X"));
    },
  );

  it("cannot change another customer's ticket in any way", async () => {
    const { app } = await twoCustomers();
    const before = await admin(app).get("/api/tickets/SUP-2");
    const one = as(app, customerOne);
    await one.put("/api/tickets/SUP-2").send({ ...valid, title: "Taken over" });
    await one.patch("/api/tickets/SUP-2").send({ status: "resolved" });
    await one.post("/api/tickets/SUP-2/archive");
    await one
      .post("/tickets/SUP-2/edit")
      .type("form")
      .send({ ...valid, title: "Taken over" });
    await one.post("/tickets/SUP-2/archive");

    expect((await admin(app).get("/api/tickets/SUP-2")).body).toEqual(before.body);
    expect((await admin(app).get("/api/tickets/SUP-2/events")).body).toHaveLength(1);
  });

  it("reads and edits their own ticket", async () => {
    const { app } = await twoCustomers();
    const one = as(app, customerOne);
    expect((await one.get("/api/tickets/SUP-1")).status).toBe(200);
    expect((await one.get("/api/tickets/SUP-1/events")).status).toBe(200);
    const edited = await one.put("/api/tickets/SUP-1").send({ ...valid, title: "My new title" });
    expect(edited.status).toBe(200);
    expect(edited.body.title).toBe("My new title");
  });

  it("cannot change the status of their own ticket", async () => {
    const { app } = await twoCustomers();
    const res = await as(app, customerOne).patch("/api/tickets/SUP-1").send({ status: "resolved" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("new");

    const page = await as(app, customerOne).get("/tickets/SUP-1");
    expect(page.text).not.toContain('action="/tickets/SUP-1/status"');
    expect(page.text).toContain('href="/tickets/SUP-1/edit"');
  });

  it("archives their own ticket, and then it is gone for them", async () => {
    const { app } = await twoCustomers();
    const one = as(app, customerOne);
    expect((await one.post("/tickets/SUP-1/archive")).headers.location).toBe("/tickets");
    expect((await one.get("/api/tickets")).body).toEqual([]);
    expect((await one.get("/api/tickets/SUP-1")).status).toBe(404);
    expect((await one.get("/tickets/SUP-1")).status).toBe(404);
    expect((await one.post("/api/tickets/SUP-1/restore")).status).toBe(404);
    // Nothing was deleted: an admin still has it.
    expect((await admin(app).get("/api/tickets/SUP-1")).body.archived_at).not.toBeNull();
  });

  it("cannot see the archived list", async () => {
    const { app } = await twoCustomers();
    expect((await as(app, customerOne).get("/api/tickets?status=archived")).status).toBe(403);
    const page = await as(app, customerOne).get("/tickets?status=archived");
    expect(page.status).toBe(403);
    expect(page.headers["content-type"]).toMatch(/html/);
    expect((await as(app, customerOne).get("/tickets")).text).not.toContain("status=archived");
    // Still nothing after one of their own is archived.
    await as(app, customerOne).post("/api/tickets/SUP-1/archive");
    expect((await as(app, customerOne).get("/api/tickets?status=archived")).status).toBe(403);
  });
});

describe("a team member", () => {
  it("lists, reads, edits and changes the status of any ticket", async () => {
    const { app } = await twoCustomers();
    const team = as(app, teamActor);
    const list = await team.get("/api/tickets");
    expect(list.body.map((t: { key: string }) => t.key)).toEqual(["SUP-2", "SUP-1"]);
    expect((await team.put("/api/tickets/SUP-1").send(valid)).status).toBe(200);
    await team.post("/api/tickets/SUP-2/take");
    const changed = await team.patch("/api/tickets/SUP-2").send({ status: "in_progress" });
    expect(changed.body.status).toBe("in_progress");

    const events = await team.get("/api/tickets/SUP-2/events");
    expect(events.body.at(-1)).toMatchObject({ actor: teamActor.id, type: "status_changed" });
  });

  it("archives a ticket, still sees it under Archived, and restores it", async () => {
    const { app } = await twoCustomers();
    const team = as(app, teamActor);
    expect((await team.post("/api/tickets/SUP-1/archive")).status).toBe(200);
    expect((await team.get("/api/tickets/SUP-1")).status).toBe(200);
    const list = await team.get("/api/tickets?status=archived");
    expect(list.body.map((t: { key: string }) => t.key)).toEqual(["SUP-1"]);
    expect((await team.get("/tickets")).text).toContain("status=archived");

    const restored = await team.post("/api/tickets/SUP-1/restore");
    expect(restored.status).toBe(200);
    expect(restored.body.archived_at).toBeNull();
    // Back with its customer.
    expect((await as(app, customerOne).get("/api/tickets/SUP-1")).status).toBe(200);
  });
});

describe("archiving asks first", () => {
  it("shows a page that explains what happens, worded for who is asking", async () => {
    const { app } = await twoCustomers();
    const mine = await as(app, customerOne).get("/tickets/SUP-1/archive");
    expect(mine.status).toBe(200);
    expect(mine.text).toContain("you will not be able to open it again");
    expect(mine.text).toContain('<form method="post" action="/tickets/SUP-1/archive">');
    expect(mine.text).toContain('href="/tickets/SUP-1"');

    const staff = await as(app, teamActor).get("/tickets/SUP-1/archive");
    expect(staff.text).toContain("You can find it under Archived and restore it.");
  });

  it("archives nothing by being opened", async () => {
    const { app } = await twoCustomers();
    await as(app, customerOne).get("/tickets/SUP-1/archive");
    expect((await admin(app).get("/api/tickets/SUP-1")).body.archived_at).toBeNull();
    expect((await admin(app).get("/api/tickets/SUP-1/events")).body).toHaveLength(1);
  });

  it("is where the ticket page sends you, instead of archiving at once", async () => {
    const { app } = await twoCustomers();
    const page = await as(app, customerOne).get("/tickets/SUP-1");
    expect(page.text).toContain('href="/tickets/SUP-1/archive"');
    expect(page.text).not.toContain('<form method="post" action="/tickets/SUP-1/archive">');
  });

  it("is not there for another customer's ticket or an archived one", async () => {
    const { app } = await twoCustomers();
    expect((await as(app, customerOne).get("/tickets/SUP-2/archive")).status).toBe(404);
    await as(app, teamActor).post("/api/tickets/SUP-1/archive");
    // Already archived: nothing to ask, so the browser is sent to the ticket.
    const again = await as(app, teamActor).get("/tickets/SUP-1/archive");
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe("/tickets/SUP-1");
  });
});

describe("an admin", () => {
  it("sees the archived list and restores", async () => {
    const { app } = await twoCustomers();
    await as(app, customerOne).post("/api/tickets/SUP-1/archive");
    const list = await admin(app).get("/api/tickets?status=archived");
    expect(list.body.map((t: { key: string }) => t.key)).toEqual(["SUP-1"]);
    expect((await admin(app).get("/tickets")).text).toContain("status=archived");

    const restored = await admin(app).post("/api/tickets/SUP-1/restore");
    expect(restored.body.archived_at).toBeNull();
    // Back with its customer.
    expect((await as(app, customerOne).get("/api/tickets/SUP-1")).status).toBe(200);
  });
});

describe("the sign-in page and the development entrance", () => {
  it("offers the made-up people and signs one in with a cookie scripts cannot read", async () => {
    const { app } = buildTestApp();
    const page = await visitor(app).get("/sign-in");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Development entrance");
    expect(page.text).toContain("Customer One (customer)");

    const res = await visitor(app).post("/sign-in/dev").type("form").send({ id: customerOne.id });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets");
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain(`${DEV_COOKIE}=${customerOne.id}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("refuses a person who is not on the list", async () => {
    const { app } = buildTestApp();
    const res = await visitor(app).post("/sign-in/dev").type("form").send({ id: "dev-owner-1" });
    expect(res.status).toBe(400);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("shows who is signed in and signs out", async () => {
    const { app } = buildTestApp();
    const page = await as(app, teamActor).get("/tickets");
    expect(page.text).toContain("Signed in as Team Member (team)");
    const res = await as(app, teamActor).post("/sign-out");
    expect(res.status).toBe(303);
    expect(String(res.headers["set-cookie"])).toContain(`${DEV_COOKIE}=;`);
  });

  it("is closed when the setting is off: no people offered and no way to sign in", async () => {
    const { app } = buildTestApp({ DEV_SIGN_IN: "off" });
    const page = await visitor(app).get("/sign-in");
    expect(page.text).toContain("Sign-in is not set up on this server yet.");
    expect(page.text).not.toContain("Customer One");
    const res = await visitor(app).post("/sign-in/dev").type("form").send({ id: customerOne.id });
    expect(res.status).toBe(404);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
