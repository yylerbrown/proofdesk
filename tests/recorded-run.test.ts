import fs from "node:fs";
import { parse } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
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
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const asTeam = () => visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-team`);
  return { ...built, asTeam };
}

describe("the recorded run on the demo", () => {
  it("is labelled, carries the same check, and was left as the run left it", async () => {
    const { asTeam } = demo();
    const ticket = (await asTeam().get("/api/tickets/SUP-8")).body;
    expect(ticket.title).toBe(
      "Recorded example of a real assistant run on 18 Nov 2026: the total adds tax twice",
    );
    expect(ticket.fix_check).toBe("total(100, 0.1) returns 110, and a test shows it");
    expect(ticket).toMatchObject({ status: "in_progress", owner_name: "Demo Team Member" });
    expect(ticket.ready_at).toBeNull();
  });

  it("holds the spec, the evidence and the review request exactly as the assistant sent them", async () => {
    const { asTeam } = demo();
    const inputs = sent();
    const spec = (await asTeam().get("/api/tickets/SUP-8")).body.spec;
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

    const [evidence] = (await asTeam().get("/api/tickets/SUP-8/evidence")).body;
    const reported = inputs.add_evidence!;
    expect(evidence).toMatchObject({
      kind: reported.kind,
      summary: reported.summary,
      command: reported.command,
      result: reported.result,
      revision: reported.revision,
      scenario: reported.scenario,
      reported_by: { kind: "agent", name: "Demo visitor ea29379c" },
    });
    expect(evidence.report).toEqual(reported.report);

    const notes = (await asTeam().get("/api/tickets/SUP-8/entries")).body as Record<
      string,
      unknown
    >[];
    expect(notes.at(-1)).toMatchObject({
      kind: "note",
      purpose: "review_request",
      author_name: "Demo visitor ea29379c",
      body: `Asks the owner to review the evidence: ${inputs.ask_owner_to_review!.message}`,
    });
  });

  it("labels the evidence with the assistant that reported it, and links the run", async () => {
    const { asTeam } = demo();
    const html = parse((await asTeam().get("/tickets/SUP-8")).text);
    expect(html.querySelector("ul.evidence")?.text).toContain(
      "Reported by Demo visitor ea29379c (AI agent)",
    );
    expect(html.querySelector(".recorded-run a")?.getAttribute("href")).toBe("/assistant-run");
  });

  it("keeps the assistant's review request apart from the customer's check, and says where SUP-4 comes from", async () => {
    const { asTeam } = demo();
    const html = parse((await asTeam().get("/tickets/SUP-8")).text);
    const check = html
      .querySelectorAll("section")
      .find((s) => s.querySelector("h2")?.text === "How will we know it's fixed?")!;
    const signal = check.querySelector(".assistant-signal")!;
    expect(signal.querySelector(".signal-from")?.text).toBe("From the AI assistant");
    expect(signal.querySelector(".review-requested")?.text).toBe(
      "Review requested by Demo visitor ea29379c",
    );
    // The customer's words come first, under the heading; the request follows them.
    const inside = check.innerHTML;
    expect(inside.indexOf("<blockquote")).toBeGreaterThan(-1);
    expect(inside.indexOf("<blockquote")).toBeLessThan(inside.indexOf("assistant-signal"));
    expect(html.querySelector(".recorded-run")?.text).toContain(
      "The run worked on the assistant sample, SUP-4, in an earlier copy of this demo",
    );
  });
});

describe("the assistant's work, on its own page", () => {
  it("is open to anyone, from the welcome page, with the summary and links to each file", async () => {
    const { app } = demo();
    const welcome = parse((await visitor(app).get("/sign-in")).text);
    expect(welcome.querySelector(".assistant-run-link a")?.text).toBe("See an assistant's work");
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
        "/tickets/SUP-8",
      ]),
    );
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
