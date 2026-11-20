import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { signedInLine } from "./helpers.js";
import { browserOf, buildPeopleApp, signedInPerson } from "./people-helpers.js";

// One lookup answers "what is this person's role" everywhere: the server settings first,
// then the role chosen on the People page, otherwise customer. A change counts on the
// person's next request, on the same running server.

const valid = { title: "Printer is broken", description: "It jams on every page." };

/** The keys of the tickets this browser's ticket list shows, from the API. */
async function visibleKeys(browser: ReturnType<typeof browserOf>): Promise<string[]> {
  const res = await browser.get("/api/tickets");
  expect(res.status).toBe(200);
  return (res.body as { key: string }[]).map((ticket) => ticket.key).sort();
}

async function setRole(boss: ReturnType<typeof browserOf>, person: string, role: string) {
  const res = await boss.post("/people").type("form").send({ person, role });
  expect(res.status).toBe(303);
}

describe("a role chosen on the People page", () => {
  it("makes a customer a team member on their next page, and back, with no restart", async () => {
    const { app, db } = buildPeopleApp();
    const boss = browserOf(app, (await signedInPerson(db, "1001", "Ada Admin")).cookie);
    const sam = await signedInPerson(db, "5005", "Sam Customer");
    const di = await signedInPerson(db, "5006", "Di Customer");
    const samBrowser = browserOf(app, sam.cookie);
    await samBrowser.post("/api/tickets").send({ ...valid, title: "Ticket of Sam" });
    await browserOf(app, di.cookie)
      .post("/api/tickets")
      .send({ ...valid, title: "Ticket of Di" });

    expect(await visibleKeys(samBrowser)).toEqual(["SUP-1"]);

    await setRole(boss, sam.id, "team");
    expect(await visibleKeys(samBrowser)).toEqual(["SUP-1", "SUP-2"]);
    const page = await samBrowser.get("/tickets");
    expect(page.text).toContain(signedInLine("Sam Customer", "team"));

    await setRole(boss, sam.id, "customer");
    expect(await visibleKeys(samBrowser)).toEqual(["SUP-1"]);
    expect((await samBrowser.get("/tickets")).text).toContain(
      signedInLine("Sam Customer", "customer"),
    );
  });

  it("puts a new team member in the hand-off list, and takes them out again", async () => {
    const { app, db } = buildPeopleApp();
    const boss = browserOf(app, (await signedInPerson(db, "1001", "Ada Admin")).cookie);
    const sam = await signedInPerson(db, "5005", "Sam Customer");
    await boss.post("/api/tickets").send(valid);
    const handOffTo = async () => {
      const page = await boss.get("/tickets/SUP-1");
      return parse(page.text)
        .querySelectorAll("form[action$='/hand-off'] option")
        .map((option) => option.text);
    };
    expect(await handOffTo()).toEqual(["Ada Admin"]);
    await setRole(boss, sam.id, "team");
    expect(await handOffTo()).toEqual(["Ada Admin", "Sam Customer"]);
    await setRole(boss, sam.id, "customer");
    expect(await handOffTo()).toEqual(["Ada Admin"]);
  });

  it("changes the role shown beside their name in a ticket's history", async () => {
    const { app, db } = buildPeopleApp();
    const ada = await signedInPerson(db, "1001", "Ada Admin");
    const boss = browserOf(app, ada.cookie);
    const sam = await signedInPerson(db, "5005", "Sam Customer");
    const di = await signedInPerson(db, "5006", "Di Customer");
    const samBrowser = browserOf(app, sam.cookie);
    const diBrowser = browserOf(app, di.cookie);
    await diBrowser.post("/api/tickets").send(valid);
    /** The role labels beside Sam's name in the history, as the customer sees it. */
    const samLabels = async () => {
      const page = await diBrowser.get("/tickets/SUP-1");
      return parse(page.text)
        .querySelectorAll("details tbody tr td:nth-child(3)")
        .filter((cell) => cell.text.includes("Sam Customer"))
        .map((cell) => cell.querySelector("small.role-label")?.text);
    };

    await setRole(boss, sam.id, "team");
    expect((await samBrowser.post("/api/tickets/SUP-1/take")).status).toBe(200);
    expect(await samLabels()).toEqual(["Team member"]);

    const handed = await samBrowser
      .post("/tickets/SUP-1/hand-off")
      .type("form")
      .send({ to: ada.id, expected_owner: sam.id });
    expect(handed.status).toBe(303);
    await setRole(boss, sam.id, "customer");
    const labels = await samLabels();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label === "Customer")).toBe(true);
  });

  it("makes someone an admin who can then open the People page", async () => {
    const { app, db } = buildPeopleApp();
    const boss = browserOf(app, (await signedInPerson(db, "1001", "Ada Admin")).cookie);
    const sam = await signedInPerson(db, "5005", "Sam Customer");
    const samBrowser = browserOf(app, sam.cookie);
    expect((await samBrowser.get("/people")).status).toBe(403);
    await setRole(boss, sam.id, "admin");
    expect((await samBrowser.get("/people")).status).toBe(200);
  });
});

describe("a role named in the server settings", () => {
  it("wins over whatever the People page's table says", async () => {
    const { app, db } = buildPeopleApp();
    const ada = await signedInPerson(db, "1001", "Ada Admin");
    const bo = await signedInPerson(db, "2002", "Bo Team");
    // As if the table had been written some other way: both made customers there.
    const now = new Date().toISOString();
    const write = db.prepare(
      "INSERT INTO people_roles (person_id, role, updated_at) VALUES (?, 'customer', ?)",
    );
    write.run(ada.id, now);
    write.run(bo.id, now);
    expect((await browserOf(app, ada.cookie).get("/tickets")).text).toContain(
      signedInLine("Ada Admin", "admin"),
    );
    expect((await browserOf(app, bo.cookie).get("/tickets")).text).toContain(
      signedInLine("Bo Team", "team"),
    );
  });
});
