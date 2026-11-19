import { parse } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { DEMO_ACTORS, DEV_COOKIE, type Actor } from "../src/server/actor.js";
import { collectNotices, notifySettingsOf } from "../src/server/notify/outbox.js";
import { AGENT_SCOPES } from "../src/server/permissions.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  teamActor,
  visitor,
} from "./helpers.js";
import { browserOf, buildPeopleApp, signedInPerson } from "./people-helpers.js";
import { giveAddresses, ok } from "./notify-life.js";

// The account page: each person sees who Proofdesk thinks they are, and switches their email
// notices off. And the header menu that leads there.

const valid = { title: "Printer is broken", description: "It jams on every page." };

/** The button of the header's person menu, as text. */
function headerViewer(html: string): string {
  const summary = parse(html).querySelector("header .person-menu summary");
  return summary?.text.replace(/\s+/g, " ").trim() ?? "";
}

/** The parts of the account page the tests read. */
function accountOf(html: string) {
  const page = parse(html);
  const box = page.querySelector("input[name=email_me]");
  return {
    text: page.querySelector("main")?.text.replace(/\s+/g, " ") ?? "",
    switchOn: box?.hasAttribute("checked") ?? null,
    switchLocked: page.querySelector("form.email-me fieldset")?.hasAttribute("disabled") ?? null,
    peopleLink: page.querySelector("main a[href='/people']") !== null,
  };
}

describe("the header", () => {
  it("names the person's menu after them, with the role as a quiet word and Account inside", async () => {
    const { app } = buildTestApp();
    const cases: [Actor, string][] = [
      [customerOne, "Customer One Customer"],
      [teamActor, "Team Member Team member"],
      // A name that is the role word already is not followed by it again.
      [adminActor, "Admin"],
    ];
    for (const [who, line] of cases) {
      const html = (await as(app, who).get("/tickets")).text;
      expect(headerViewer(html), who.id).toBe(line);
      const link = parse(html).querySelector("header .person-menu a[href='/account']");
      expect(link?.text, who.id).toBe("Account");
    }
  });

  it("calls the demo's admin preview read-only in its menu's button", async () => {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const demoAdmin = DEMO_ACTORS.find((who) => who.readOnly === true)!;
    const html = (await as(app, demoAdmin).get("/tickets")).text;
    expect(headerViewer(html)).toBe("Demo Admin (read-only)");
  });
});

describe("the account page", () => {
  it("shows only the viewer's own name, address and role", async () => {
    const { app, db } = buildPeopleApp();
    const sam = await signedInPerson(db, "5005", "Sam Customer");
    await signedInPerson(db, "5006", "Di Customer");
    const res = await browserOf(app, sam.cookie).get("/account?id=anything&person=5006");
    expect(res.status).toBe(200);
    const page = accountOf(res.text);
    expect(page.text).toContain("Sam Customer");
    expect(page.text).toContain("5005@example.com");
    expect(page.text).toContain("Customer");
    expect(page.peopleLink).toBe(false);
    expect(page.text).not.toContain("Di Customer");
    expect(page.text).not.toContain("5006@example.com");
  });

  it("is four rows and nothing else, for every role", async () => {
    const { app, db } = buildPeopleApp();
    const sam = await signedInPerson(db, "5005", "Sam Customer");
    const boss = await signedInPerson(db, "1001", "Ada Admin");
    const tom = await signedInPerson(db, "2002", "Tom Team");
    for (const [who, role] of [
      [sam, "Customer"],
      [boss, "Admin"],
      [tom, "Team member"],
    ] as const) {
      const html = parse((await browserOf(app, who.cookie).get("/account")).text);
      const main = html.querySelector("main")!;
      const rows = main.querySelectorAll("dl.account-card > .account-row");
      expect(rows.map((row) => row.querySelector("dt")?.text)).toEqual([
        "Name",
        "Email",
        "Role",
        "Email notices",
      ]);
      expect(main.querySelector(".account-role")?.text, role).toBe(role);
      // The role row is the role word alone: no sentence under it, and People stays in the menu.
      expect(main.querySelector("a[href='/people']"), role).toBeNull();
      const words = main.text.replace(/\s+/g, " ");
      expect(words, role).not.toContain("From your GitHub account");
      expect(words, role).not.toContain("Ask an admin to add you");
      expect(words, role).not.toContain("You see every ticket");
    }
  });

  it("sends a signed-out visitor to sign in", async () => {
    const { app } = buildTestApp();
    const res = await visitor(app).get("/account");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/sign-in?next=%2Faccount");
  });

  it("is not open to an assistant's connection key", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    const made = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: [...AGENT_SCOPES] });
    const key = keyOnPage(made.text);
    const seen = await request(app).get("/account").set("Authorization", `Bearer ${key}`);
    expect(seen.status).toBe(303);
    expect(seen.headers.location).toBe("/sign-in?next=%2Faccount");
    expect(seen.text).not.toContain("@example.com");
    const saved = await request(app)
      .post("/account")
      .set("Authorization", `Bearer ${key}`)
      .set("Sec-Fetch-Site", "same-origin")
      .type("form")
      .send({});
    expect(saved.status).not.toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM email_settings").get()).toEqual({ n: 0 });
  });
});

describe("the email switch", () => {
  it("is on by default, saves off and on, and survives a reload", async () => {
    const { app } = buildTestApp();
    const browser = as(app, customerOne);
    expect(accountOf((await browser.get("/account")).text).switchOn).toBe(true);

    const off = await browser.post("/account").type("form").send({});
    expect(off.status).toBe(303);
    expect(off.headers.location).toBe("/account");
    const saved = await browser.get("/account");
    expect(accountOf(saved.text).switchOn).toBe(false);
    expect(saved.text).toContain("Saved. Proofdesk will not email you about your tickets.");
    const reloaded = await browser.get("/account");
    expect(accountOf(reloaded.text).switchOn).toBe(false);
    expect(reloaded.text).not.toContain("Saved.");

    // Another person's switch is their own.
    expect(accountOf((await as(app, customerTwo).get("/account")).text).switchOn).toBe(true);

    await browser.post("/account").type("form").send({ email_me: "on" });
    expect(accountOf((await browser.get("/account")).text).switchOn).toBe(true);
  });

  it("means no notice is written for a person who switched it off", async () => {
    const { app, db, config } = buildTestApp({
      SMTP_URL: "smtps://notices:pw@mail.example.com:465",
      MAIL_FROM: "notices@example.com",
    });
    giveAddresses(db);
    await ok(as(app, customerOne).post("/api/tickets").send(valid), 201);
    await ok(as(app, customerTwo).post("/api/tickets").send(valid), 201);
    await ok(as(app, customerOne).post("/account").type("form").send({}), 303);
    for (const key of ["SUP-1", "SUP-2"]) {
      await ok(
        as(app, teamActor)
          .post(`/api/tickets/${key}/entries`)
          .send({ kind: "reply", body: "On it." }),
        201,
      );
    }
    collectNotices(db, { ...notifySettingsOf(config), mailConfigured: true });
    const rows = db.prepare("SELECT recipient_id, state FROM email_outbox ORDER BY id").all();
    expect(rows).toEqual([{ recipient_id: "dev-customer-2", state: "pending" }]);
  });

  it("refuses a post from another site and keeps the setting", async () => {
    const { app, db } = buildTestApp();
    const res = await request(app)
      .post("/account")
      .set("Cookie", `${DEV_COOKIE}=${customerOne.id}`)
      .set("Sec-Fetch-Site", "cross-site")
      .type("form")
      .send({});
    expect(res.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM email_settings").get()).toEqual({ n: 0 });
  });

  it("says plainly when this site has no mail server, and nothing when it has one", async () => {
    const without = buildTestApp();
    const plain = accountOf((await as(without.app, customerOne).get("/account")).text);
    expect(plain.text).toContain("This site has no mail server set up, so no email is sent yet.");

    const withMail = buildTestApp({
      SMTP_URL: "smtps://notices:pw@mail.example.com:465",
      MAIL_FROM: "notices@example.com",
    });
    const mailed = accountOf((await as(withMail.app, customerOne).get("/account")).text);
    expect(mailed.text).not.toContain("no mail server");
    expect(mailed.text).not.toContain("never sends email");
  });

  it("is shown but cannot be changed on the demo, which never sends email", async () => {
    const { app, db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    for (const who of DEMO_ACTORS) {
      const page = accountOf((await as(app, who).get("/account")).text);
      const rows = parse((await as(app, who).get("/account")).text).querySelectorAll(
        "dl.account-card > .account-row",
      );
      expect(rows[1]?.querySelector("dd")?.text, who.id).toBe("None on the demo");
      // The quiet words sit on the switch's own row.
      expect(rows[3]?.querySelector(".mail-line")?.text, who.id).toBe("The demo sends no email");
      expect(page.switchOn, who.id).toBe(true);
      expect(page.switchLocked, who.id).toBe(true);
      const tried = await as(app, who).post("/account").type("form").send({});
      expect(tried.status, who.id).toBe(403);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM email_settings").get()).toEqual({ n: 0 });
  });
});
