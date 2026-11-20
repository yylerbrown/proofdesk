import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import {
  DEMO_BUDGET,
  OTHER_DEMO_CUSTOMERS,
  readDemoSeed,
  ROOM_KEPT_FOR_VISITORS,
  seedDemo,
} from "../src/server/demo.js";
import {
  fileSampleBatch,
  planSampleBatch,
  SAMPLE_PROBLEMS,
  type SampleBatchInput,
} from "../src/server/demo-sample-batch.js";
import { HttpError } from "../src/server/errors.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, visitor } from "./helpers.js";

// On the demo, "Add sample tickets" on About this demo files a batch of made-up tickets with
// believable past times, so a visitor has a fuller list to filter, sort and search.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date("2026-11-19T20:00:00.000Z");
const [customer, team] = DEMO_ACTORS as [(typeof DEMO_ACTORS)[0], (typeof DEMO_ACTORS)[1]];
const customers = [customer, ...OTHER_DEMO_CUSTOMERS];

function plan(seed: number, input: SampleBatchInput) {
  return planSampleBatch(seed, input, customers, team, NOW);
}

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const asDemo = (id: string) => visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`);
  const count = () =>
    (built.db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
  return { ...built, asDemo, count };
}

describe("the plan for a batch of sample tickets", () => {
  it("draws on a pool of at least forty problems, about two in three with a proof", () => {
    expect(SAMPLE_PROBLEMS.length).toBeGreaterThanOrEqual(40);
    const titles = new Set(SAMPLE_PROBLEMS.map((problem) => problem.title));
    expect(titles.size).toBe(SAMPLE_PROBLEMS.length);
    const withProof = SAMPLE_PROBLEMS.filter((problem) => problem.fixCheck !== null).length;
    expect(withProof / SAMPLE_PROBLEMS.length).toBeGreaterThan(0.6);
    expect(withProof / SAMPLE_PROBLEMS.length).toBeLessThan(0.72);
  });

  it("is the same for the same seed, and different for another", () => {
    const input = { count: 25, period: "month" } as const;
    expect(plan(7, input)).toEqual(plan(7, input));
    expect(plan(8, input)).not.toEqual(plan(7, input));
    // Pinned for one seed, so a change to the plan is a change a test sees.
    const [first, second] = plan(7, input);
    expect(first).toMatchObject({
      title: "Order history is empty",
      filedAt: "2026-11-08T19:21:00.000Z",
      filer: { id: "demo-customer-3" },
    });
    expect(first!.taken).toBeUndefined();
    expect(second).toMatchObject({
      title: "Contact form gives no confirmation",
      filedAt: "2026-10-22T17:56:00.000Z",
      taken: { by: { id: "demo-team" }, at: "2026-10-22T22:29:00.000Z" },
    });
    expect(second!.resolved).toBeUndefined();
  });

  it("files every step in order, before now, within the period, at working hours", () => {
    for (const seed of [1, 2, 3]) {
      for (const [period, days] of [
        ["week", 7],
        ["month", 30],
        ["quarter", 90],
      ] as const) {
        for (const sample of plan(seed, { count: 50, period })) {
          const filed = Date.parse(sample.filedAt);
          expect(filed).toBeLessThan(NOW.getTime());
          expect(filed).toBeGreaterThan(NOW.getTime() - (days + 1) * DAY);
          expect(new Date(filed).getUTCHours()).toBeGreaterThanOrEqual(15);
          const steps = [
            sample.filedAt,
            sample.taken?.at,
            sample.resolved?.at,
            sample.resolved?.confirmedAt ?? undefined,
          ].filter((at): at is string => at !== undefined);
          const times = steps.map((at) => Date.parse(at));
          expect(times).toEqual([...times].sort((a, b) => a - b));
          expect(Math.max(...times)).toBeLessThan(NOW.getTime());
          if (sample.taken) expect(sample.taken.by.id).toBe("demo-team");
          // The team's steps happen in working hours too.
          for (const at of [sample.taken?.at, sample.resolved?.at]) {
            if (at !== undefined) expect(new Date(at).getUTCHours()).toBeGreaterThanOrEqual(15);
          }
          if (sample.resolved && sample.resolved.confirmedAt !== null) {
            expect(sample.fixCheck).not.toBeNull();
          }
        }
      }
    }
  });

  it("mixes New, In Progress and Resolved, both ways resolved, and older resolved tickets", () => {
    const samples = plan(3, { count: 50, period: "quarter" });
    const isNew = samples.filter((sample) => sample.taken === undefined);
    const working = samples.filter((sample) => sample.taken && !sample.resolved);
    const resolved = samples.filter((sample) => sample.resolved !== undefined);
    const confirmed = resolved.filter((sample) => sample.resolved!.confirmedAt !== null);
    const byTeam = resolved.filter((sample) => sample.resolved!.confirmedAt === null);
    for (const group of [isNew, working, confirmed, byTeam])
      expect(group.length).toBeGreaterThan(2);
    const older = resolved.filter((s) => Date.parse(s.resolved!.at) < NOW.getTime() - 14 * DAY);
    expect(older.length).toBeGreaterThan(2);
    // Filed by every demo customer, the demo customer among them.
    const filers = new Set(samples.map((sample) => sample.filer.id));
    expect(filers).toEqual(new Set(customers.map((person) => person.id)));
  });

  it("leaves nothing resolved more than 14 days ago when filed over the last week", () => {
    for (const sample of plan(5, { count: 50, period: "week" })) {
      if (sample.resolved) {
        expect(Date.parse(sample.resolved.at)).toBeGreaterThan(NOW.getTime() - 14 * DAY);
      }
    }
  });
});

describe("Add sample tickets, on the demo", () => {
  it("is one quiet line and form at the end of About this demo, for a visitor signed in", async () => {
    const { asDemo } = demo();
    const html = parse((await asDemo("demo-customer").get("/sign-in")).text);
    const form = html.querySelector(".about-demo form.sample-batch")!;
    expect(form.getAttribute("action")).toBe("/demo/samples");
    expect(form.querySelector("p")?.text).toBe(
      "Want a fuller list to filter, sort and search? Add made-up tickets.",
    );
    const count = form.querySelector("select[name=count]")!;
    expect(count.querySelectorAll("option").map((option) => option.text)).toEqual([
      "10",
      "25",
      "50",
    ]);
    expect(count.querySelector("option[selected]")?.text).toBe("10");
    const period = form.querySelector("select[name=period]")!;
    expect(period.querySelectorAll("option").map((option) => option.text)).toEqual([
      "The last week",
      "The last month",
      "The last three months",
    ]);
    expect(period.querySelector("option[selected]")?.text).toBe("The last month");
    const button = form.querySelector("button")!;
    expect(button.text).toBe("Add sample tickets");
    expect(button.classList.contains("secondary")).toBe(true);
    // It is the About page's last part, with no heading of its own.
    expect(html.querySelector(".about-demo")?.lastElementChild).toBe(form);
    expect(form.querySelectorAll("h1, h2, h3, h4")).toHaveLength(0);
  });

  it("is not offered to the read-only preview, nor anywhere on the ticket list", async () => {
    const { asDemo } = demo();
    const about = (await asDemo("demo-admin").get("/sign-in")).text;
    expect(about).not.toContain("/demo/samples");
    expect((await asDemo("demo-customer").get("/tickets")).text).not.toContain("/demo/samples");
  });

  it("files that many tickets and opens the list with a one-time line", async () => {
    const { asDemo, count } = demo();
    const before = count();
    const pressed = await asDemo("demo-customer")
      .post("/demo/samples")
      .type("form")
      .send({ count: "25", period: "month" });
    expect(pressed.status).toBe(303);
    expect(pressed.headers.location).toBe("/tickets");
    expect(count()).toBe(before + 25);
    const cookie = [pressed.headers["set-cookie"]].flat().join("; ");
    const list = await asDemo("demo-customer").get("/tickets").set("Cookie", cookie);
    expect(parse(list.text).querySelector("p.saved")?.text).toBe(
      "Added 25 sample tickets. The demo returns to its samples when it resets.",
    );
  });

  it("writes a sensible History, sends no email and hands nothing to an assistant", async () => {
    const { asDemo, db } = demo();
    const seed = readDemoSeed(db);
    const outboxBefore = db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get();
    await asDemo("demo-team")
      .post("/demo/samples")
      .type("form")
      .send({ count: "50", period: "quarter" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get()).toEqual(outboxBefore);
    // The record of what the seed wrote, which is all a demo connection is shown, is unchanged.
    expect(readDemoSeed(db)).toEqual(seed);
    const seeded = Math.max(...seed!.tickets);
    const rows = db.prepare("SELECT id FROM tickets WHERE id > ?").all(seeded) as { id: number }[];
    const added = rows.map((row) => ({ key: `SUP-${row.id}` }));
    expect(added).toHaveLength(50);
    for (const ticket of added) {
      const events = (await asDemo("demo-team").get(`/api/tickets/${ticket.key}/events`)).body as {
        type: string;
        created_at: string;
      }[];
      expect(events[0]!.type).toBe("created");
      expect(events.map((event) => event.type)).not.toContain("agent_handed");
      const times = events.map((event) => Date.parse(event.created_at));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(Math.max(...times)).toBeLessThan(Date.now());
    }
  });

  it("adds nothing when the batch would not fit the demo's budget, and says the demo is full", async () => {
    const { asDemo, count, db } = demo();
    const insert = db.prepare(
      "INSERT INTO tickets (title, description, created_by, created_at, updated_at) VALUES ('Filler', 'Filler', 'demo-customer', ?, ?)",
    );
    const now = new Date().toISOString();
    while (count() < (DEMO_BUDGET.tickets ?? 0) - 5) insert.run(now, now);
    const before = count();
    const pressed = await asDemo("demo-customer")
      .post("/demo/samples")
      .type("form")
      .send({ count: "10", period: "week" });
    expect(pressed.status).toBe(303);
    expect(count()).toBe(before);
    const cookie = [pressed.headers["set-cookie"]].flat().join("; ");
    const list = await asDemo("demo-customer").get("/tickets").set("Cookie", cookie);
    expect(parse(list.text).querySelector("p.saved")?.text).toBe(
      "The demo is full of samples. It returns to its own when it resets.",
    );
  });

  it("always leaves room for visitors to file their own tickets, however often it is pressed", async () => {
    const { asDemo, count } = demo();
    const fullLine = "The demo is full of samples. It returns to its own when it resets.";
    let line = "";
    for (let press = 0; press < 10 && line !== fullLine; press++) {
      const pressed = await asDemo("demo-customer")
        .post("/demo/samples")
        .type("form")
        .send({ count: "50", period: "month" });
      const cookie = [pressed.headers["set-cookie"]].flat().join("; ");
      const list = await asDemo("demo-customer").get("/tickets").set("Cookie", cookie);
      line = parse(list.text).querySelector("p.saved")?.text ?? "";
    }
    expect(line).toBe(fullLine);
    const room = (DEMO_BUDGET.tickets ?? 0) - count();
    expect(room).toBeGreaterThanOrEqual(ROOM_KEPT_FOR_VISITORS);
    // A visitor can still file a ticket of their own.
    const filed = await asDemo("demo-customer")
      .post("/tickets")
      .type("form")
      .send({ title: "My own problem", description: "Filed after the samples." });
    expect(filed.status).toBe(303);
    expect(filed.headers.location).toMatch(/^\/tickets\/SUP-\d+/);
  });

  it("files nothing for someone who is not a demo visitor, even when called directly", () => {
    const { db, config } = demo();
    const place = { db, prefix: config.ticketPrefix, logEvent: () => {} };
    const before = (db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
    let thrown: unknown;
    try {
      fileSampleBatch(place, 1000, { count: "10", period: "week" }, customerOne, 1, NOW);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({ status: 403 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(before);
  });

  it("refuses the read-only preview, a size it does not offer and a cross-site post", async () => {
    const { app, asDemo, count } = demo();
    const before = count();
    const send = { count: "10", period: "week" };
    const preview = await asDemo("demo-admin").post("/demo/samples").type("form").send(send);
    expect(preview.status).toBe(403);
    const odd = await asDemo("demo-customer")
      .post("/demo/samples")
      .type("form")
      .send({ count: "500", period: "week" });
    expect(odd.status).toBe(400);
    const crossSite = await visitor(app)
      .post("/demo/samples")
      .set("Cookie", `${DEV_COOKIE}=demo-customer`)
      .set("Sec-Fetch-Site", "cross-site")
      .type("form")
      .send(send);
    expect(crossSite.status).toBe(403);
    expect(count()).toBe(before);
  });
});

describe("Add sample tickets, off the demo", () => {
  it("has no form and no address", async () => {
    const { app } = buildTestApp();
    const about = await as(app, customerOne).get("/sign-in");
    expect(about.text).not.toContain("/demo/samples");
    const pressed = await as(app, customerOne)
      .post("/demo/samples")
      .type("form")
      .send({ count: "10", period: "week" });
    expect(pressed.status).toBe(404);
  });
});
