import fs from "node:fs";
import { parse } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { RECORDED_ASSISTANT, seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// The recorded example of a real assistant run: the demo ticket carries what the assistant sent,
// copied from its transcript and compared with it here, and its files are public.

const RUN = "docs/assistant-run";

/** What the assistant sent to each Proofdesk tool, read from the kept transcript. */
function sent(): Record<string, Record<string, unknown>> {
  const inputs: Record<string, Record<string, unknown>> = {};
  for (const line of fs.readFileSync(`${RUN}/transcript.public.jsonl`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { message?: { content?: unknown } };
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; name?: string; input?: object }[]) {
      if (block.type === "tool_use" && block.name?.includes("proofdesk")) {
        inputs[block.name.split("__").at(-1)!] = block.input as Record<string, unknown>;
      }
    }
  }
  return inputs;
}

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  const service = createTicketService(built.db, built.config.ticketPrefix);
  seedDemo(service);
  const asTeam = () => visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-team`);
  // The seed records its samples' keys, so no test names a fixed number for them.
  const sample = service.assistantSampleKey() ?? "none";
  const recorded = service.recordedRunKey() ?? "none";
  return { ...built, asTeam, sample, recorded };
}

describe("the recorded run on the demo", () => {
  it("reads like a ticket, carries the same check, and was left as the run left it", async () => {
    const { asTeam, recorded } = demo();
    const ticket = (await asTeam().get(`/api/tickets/${recorded}`)).body;
    // The title is the problem and the description is the customer's report alone.
    expect(ticket.title).toBe("The checkout total adds tax twice");
    expect(ticket.description).toBe(
      "The checkout total is too high. This is the code that computes it:\n\n" +
        "function total(price, taxRate) {\n  return price + price * taxRate + price * taxRate;\n}\n\n" +
        "total(100, 0.1) returns 120.",
    );
    expect(ticket.fix_check).toBe("total(100, 0.1) returns 110, and a test shows it");
    expect(ticket).toMatchObject({ status: "in_progress", owner_name: "Demo Team Member" });
    expect(ticket.ready_at).toBeNull();
  });

  it("holds the spec, the evidence and the review request exactly as the assistant sent them", async () => {
    const { asTeam, recorded } = demo();
    const inputs = sent();
    const spec = (await asTeam().get(`/api/tickets/${recorded}`)).body.spec;
    expect(spec.state).toBe("proposed");
    expect(spec.summary).toBe(inputs.propose_spec!.summary);
    expect(
      spec.scenarios.map(({ title, given, when, then, test_name }: Record<string, string>) => ({
        title,
        given,
        when,
        then,
        test_name,
      })),
    ).toEqual(inputs.propose_spec!.scenarios);

    const [evidence] = (await asTeam().get(`/api/tickets/${recorded}/evidence`)).body;
    const reported = inputs.add_evidence!;
    expect(evidence).toMatchObject({
      kind: reported.kind,
      summary: reported.summary,
      command: reported.command,
      result: reported.result,
      revision: reported.revision,
      scenario: reported.scenario,
      reported_by: { kind: "agent", name: RECORDED_ASSISTANT.name },
    });
    expect(evidence.report).toEqual(reported.report);

    const notes = (await asTeam().get(`/api/tickets/${recorded}/entries`)).body as Record<
      string,
      unknown
    >[];
    expect(notes.at(-1)).toMatchObject({
      kind: "note",
      purpose: "review_request",
      author_name: RECORDED_ASSISTANT.name,
      body: `Asks the owner to review the evidence: ${inputs.ask_owner_to_review!.message}`,
    });
  });

  it("labels the evidence with the assistant that reported it, and links the run", async () => {
    const { asTeam, recorded } = demo();
    const html = parse((await asTeam().get(`/tickets/${recorded}`)).text);
    expect(html.querySelector("ul.evidence")?.text).toContain(
      "Reported by Demo visitor's assistant (AI agent)",
    );
  });

  it("says inside the assistant card that it is a recorded run and links to how it was run", async () => {
    const { asTeam, recorded } = demo();
    const html = parse((await asTeam().get(`/tickets/${recorded}`)).text);
    const note = html.querySelector(".assistant-card .card-recorded")!;
    // The title and the description are the customer's problem alone, so this one line in the
    // assistant's card is the one place on the ticket that says a recorded run is shown, and
    // under which key the assistant knew the sample.
    expect(note.text).toBe("Recorded on 18 Nov 2026, when this sample was SUP-4. How this was run");
    expect(html.querySelectorAll(".card-recorded")).toHaveLength(1);
    expect(html.querySelector(".recorded-run")).toBeNull();
    const link = note.querySelector("a")!;
    expect(link.text).toBe("How this was run");
    expect(link.getAttribute("href")).toBe("/assistant-run#how-it-was-run");
    // The address's #part names a place inside the closed "How this was run" section, so a
    // browser opens it with no script.
    const run = parse((await visitor(demo().app).get("/assistant-run")).text);
    const target = run.getElementById("how-it-was-run")!;
    expect(target.parentNode?.tagName).toBe("DETAILS");
    expect(target.parentNode?.querySelector("summary")?.text).toBe("How this was run");
  });

  it("keeps the assistant's review request apart from the customer's check", async () => {
    const { asTeam, recorded } = demo();
    const html = parse((await asTeam().get(`/tickets/${recorded}`)).text);
    const check = html
      .querySelectorAll("section")
      .find((s) => s.querySelector("h2")?.text === "How will we know it's fixed?")!;
    // The panel's check holds the customer's words alone; the request sits in the main column.
    expect(check.querySelector("blockquote")).not.toBeNull();
    expect(check.querySelector(".assistant-card")).toBeNull();
    // Everything the assistant left is one card, which says whose it is and who asked for review.
    const cards = html.querySelectorAll(".ticket-summary .assistant-card");
    expect(cards).toHaveLength(1);
    const signal = cards[0]!;
    expect(signal.querySelector(".card-from")?.text).toBe(
      "From the AI assistant · Review requested by Demo visitor's assistant",
    );
    expect(signal.querySelectorAll("h2, h3")).toHaveLength(0);
    expect(signal.querySelector(".review-requested")?.text).toBe(
      "Review requested by Demo visitor's assistant",
    );
  });

  it("says on the run page, not on the ticket, why the assistant's words name SUP-4", async () => {
    const { app } = demo();
    const run = parse((await visitor(app).get("/assistant-run")).text);
    expect(run.getElementById("how-it-was-run")?.text).toBe(
      "The run was recorded on 18 Nov 2026 against the sample ticket of an earlier copy of this demo, where that ticket was SUP-4, which is why the assistant's own words name SUP-4. What the ticket shows from the assistant is exactly what it sent.",
    );
  });
});

describe("the assistant's work, on its own page", () => {
  it("is open to anyone, with the summary and links to each file", async () => {
    const { app } = demo();
    const page = parse((await visitor(app).get("/assistant-run")).text);
    expect(page.querySelector("h1")?.text).toBe("An assistant's work");
    // The summary as headed sections: every heading in summary.md is a heading on the page,
    // and none of Markdown's marks are left.
    const summary = page.querySelector(".run-summary")!;
    const headings = summary.querySelectorAll("h2, h3").map((h) => h.text);
    const kept = fs.readFileSync(`${RUN}/summary.md`, "utf8");
    for (const [, heading] of kept.matchAll(/^#{1,2} (.+)$/gm)) expect(headings).toContain(heading);
    // Code keeps its own characters (the command's file patterns use **); prose has no marks.
    const prose = parse(summary.toString());
    for (const code of prose.querySelectorAll("pre, code")) code.remove();
    expect(prose.text).not.toMatch(/^#+ |\*\*/m);
    const links = page.querySelectorAll("main a").map((a) => a.getAttribute("href"));
    expect(links).toEqual(
      expect.arrayContaining([
        "/assistant-run/files/transcript.public.jsonl",
        "/assistant-run/files/sup4/total.js",
        "/assistant-run/files/sup4/total.test.js",
      ]),
    );
  });

  it("never links a viewer to a ticket they cannot open, and opens it for them as the team", async () => {
    const { app, recorded } = demo();
    const viewers: [string, ReturnType<typeof visitor>][] = [
      ["signed out", visitor(app)],
      ...["demo-customer", "demo-team", "demo-admin"].map(
        (id): [string, ReturnType<typeof visitor>] => [
          id,
          visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`),
        ],
      ),
    ];
    for (const [who, browser] of viewers) {
      const page = parse((await browser.get("/assistant-run")).text);
      for (const href of page.querySelectorAll("main a").map((a) => a.getAttribute("href"))) {
        if (!href?.startsWith("/tickets/")) continue;
        expect((await browser.get(href)).status, `${who} ${href}`).toBe(200);
      }
    }
    // A customer and a signed-out visitor get one press that opens it as the team member.
    for (const browser of [
      visitor(app),
      visitor(app).set("Cookie", `${DEV_COOKIE}=demo-customer`),
    ]) {
      const form = parse((await browser.get("/assistant-run")).text).querySelector(
        ".recorded-ticket form",
      )!;
      expect(form.querySelector("button")?.text).toBe("Open it as Demo Team Member");
      const fields = Object.fromEntries(
        form
          .querySelectorAll("input")
          .map((i) => [i.getAttribute("name"), i.getAttribute("value")]),
      );
      const sent = await visitor(app).post(form.getAttribute("action")!).type("form").send(fields);
      expect(sent.headers.location).toBe(`/tickets/${recorded}`);
      const cookie = sent.headers["set-cookie"] as unknown as string[];
      const opened = await visitor(app).get(`/tickets/${recorded}`).set("Cookie", cookie);
      expect(opened.status).toBe(200);
    }
  });

  it("shows the exact command the run used, as the summary keeps it", async () => {
    const { app } = demo();
    // Read inside <pre> too, which the parser otherwise keeps as raw text.
    const page = parse((await visitor(app).get("/assistant-run")).text, {
      blockTextElements: { script: true, style: true },
    });
    const shown = page.querySelector("pre.run-command code")!.text;
    const kept = fs.readFileSync(`${RUN}/summary.md`, "utf8");
    const block = /## How it was run[\s\S]*?```sh\n([\s\S]*?)\n```/.exec(kept)![1]!;
    expect(shown).toBe(block);
    expect(shown).toContain('"sandbox":{"enabled":true');
    expect(shown).not.toContain("sandbox on");
  });

  it("serves the kept files as plain text, exactly as kept", async () => {
    const { app } = demo();
    for (const file of ["transcript.public.jsonl", "sup4/total.js", "sup4/total.test.js"]) {
      const res = await request(app)
        .get(`/assistant-run/files/${file}`)
        .buffer(true)
        .parse((r, cb) => {
          let body = "";
          r.on("data", (chunk: Buffer) => (body += chunk.toString()));
          r.on("end", () => cb(null, body));
        });
      expect(res.status, file).toBe(200);
      expect(res.headers["content-type"], file).toMatch(/^text\/plain/);
      expect(res.body, file).toBe(fs.readFileSync(`${RUN}/${file}`, "utf8"));
    }
  });

  it("keeps no key, local path or personal detail in what it publishes", () => {
    for (const file of [
      "transcript.public.jsonl",
      "summary.md",
      "sup4/total.js",
      "sup4/total.test.js",
    ]) {
      const text = fs.readFileSync(`${RUN}/${file}`, "utf8");
      expect(text, file).not.toMatch(/pd_[0-9a-f]{8}_[A-Za-z0-9_-]{8,}/);
      expect(text, file).not.toMatch(/\/Users\/|Bearer [A-Za-z0-9]/);
    }
  });
});

describe("the run page on a phone", () => {
  it("stacks each fact's label above its paragraph, in the body size", async () => {
    const { app } = demo();
    const page = parse((await visitor(app).get("/assistant-run")).text);
    const facts = page.querySelector(".run-summary dl.run-facts")!;
    expect(facts.querySelectorAll("dt").map((dt) => dt.text)).toEqual([
      "When",
      "Product",
      "Assistant",
      "Outcome",
    ]);
    // Not the two-column evidence layout, which squeezed the long Outcome into a narrow column.
    expect(page.querySelector(".run-summary dl.evidence-fields")).toBeNull();
    const css = fs.readFileSync("public/site.css", "utf8");
    const dd = /dl\.run-facts dd \{([^}]*)\}/.exec(css)![1]!;
    expect(dd).not.toContain("font-size");
  });
});

describe("the demo's history and the assistant samples' customer", () => {
  it("names every person and assistant in history, never Unknown person or a raw id", async () => {
    const { app, recorded } = demo();
    const as = (id: string) => visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);
    const who = async (key: string, viewer: string) =>
      parse((await as(viewer).get(`/tickets/${key}`)).text)
        .querySelectorAll("details.history tbody tr")
        .map((row) => row.querySelectorAll("td")[2]!.text.replace(/\s+/g, " ").trim());
    for (let n = 1; n <= 8; n++) {
      const rows = await who(`SUP-${n}`, "demo-team");
      expect(rows.join(" | "), `SUP-${n}`).not.toMatch(/Unknown person|demo-recorded-assistant/);
    }
    expect(await who("SUP-7", "demo-admin")).toContain("Second Demo Customer customer");
    expect(await who("SUP-8", "demo-admin")).toContain("Third Demo Customer customer");
    expect(await who(recorded, "demo-team")).toContain("Demo visitor's assistant (AI agent)");
    // Named in plain words, with no connection id.
    expect(RECORDED_ASSISTANT.name).not.toMatch(/[0-9a-f]{6,}/);
  });

  it("files both assistant samples for another customer, out of the demo customer's own list", async () => {
    const { app, sample, recorded } = demo();
    const as = (id: string) => visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);
    const mine = (await as("demo-customer").get("/api/tickets")).body as { key: string }[];
    const keys = mine.map((ticket) => ticket.key);
    expect(keys).not.toContain(sample);
    expect(keys).not.toContain(recorded);
    expect((await as("demo-customer").get(`/tickets/${recorded}`)).status).toBe(404);
    for (const key of [sample, recorded]) {
      const rows = parse((await as("demo-admin").get(`/tickets/${key}`)).text)
        .querySelectorAll("details.history tbody tr")
        .map((row) => row.text.replace(/\s+/g, " ").trim());
      expect(
        rows.find((row) => row.includes("Ticket filed")),
        key,
      ).toContain("Second Demo Customer");
    }
    // Where the recorded run's words come from is told on the run page, so the ticket's
    // description holds the customer's report alone.
    const description = parse(
      (await as("demo-team").get(`/tickets/${recorded}`)).text,
    ).querySelector("h2 + p.user-text")!.text;
    expect(description).toMatch(/^The checkout total is too high\./);
    expect(description).not.toMatch(/recorded|earlier copy|SUP-4/i);
  });
});
