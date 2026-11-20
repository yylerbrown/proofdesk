import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, buildTestApp } from "./helpers.js";
import { BUTTON_WORDS } from "../src/browser/proof-step.js";
import { keyOnPage } from "./key-on-page.js";

// The page that shows a new key is one message to paste into an AI agent, one sentence about
// the key, and the manual setup folded away under "If that did not work".

/** The "Next" part of the page for a new connection with this Suggestions setting. */
async function nextPart(suggestions: string) {
  const { app } = buildTestApp();
  const res = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets"], suggestions });
  const page = parse(res.text, { blockTextElements: { script: true, style: true } });
  const next = page.querySelector(".connection-created .connection-next")!;
  return {
    app,
    facts: page.querySelector(".connection-facts")!.text,
    label: next.querySelector(".next-label")!.text,
    lines: next.querySelectorAll("p:not(.next-label)").map((p) => p.text),
    links: next.querySelectorAll("a").map((a) => a.getAttribute("href")),
    message: page.querySelector("#agent-paste code")!.text,
    blackButtons: page.querySelectorAll("main button:not(.secondary):not(.copy)").length,
  };
}

const HAND_IT =
  "Hand it a ticket: open a ticket, set its Status to In Progress, then More options, Hand to an AI assistant.";

describe("what to do next, on the page that shows a new key", () => {
  it("names the step that makes Hand to an AI assistant appear on a ticket", async () => {
    const { app } = buildTestApp();
    await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets"] });
    await admin(app).post("/api/tickets").send({ title: "Printer jams", description: "Jams." });
    const offersHandOver = async () =>
      parse((await admin(app).get("/tickets/SUP-1")).text)
        .querySelectorAll("details.more-options summary")
        .some((summary) => summary.text.trim() === "Hand to an AI assistant");
    // A ticket that is still New does not offer it, even to its owner.
    await admin(app).post("/api/tickets/SUP-1/take");
    expect(await offersHandOver()).toBe(false);
    // Setting its Status to In Progress, as the words say, does.
    const page = parse((await admin(app).get("/tickets/SUP-1")).text);
    const inProgress = page
      .querySelectorAll(".status-menu form")
      .find((form) => form.querySelector("button")!.text.trim().startsWith("In Progress"))!;
    const fields = Object.fromEntries(
      inProgress
        .querySelectorAll("input[type=hidden]")
        .map((input) => [input.getAttribute("name")!, input.getAttribute("value")!]),
    );
    const moved = await admin(app)
      .post(inProgress.getAttribute("action")!)
      .type("form")
      .send(fields);
    expect(moved.status).toBeLessThan(400);
    expect(await offersHandOver()).toBe(true);
  });

  it("with Suggestions Off, says the setting and only how to hand it a ticket", async () => {
    const next = await nextPart("off");
    expect(next.facts).toBe("Helper. Suggestions: Off.");
    expect(next.label).toBe("Next");
    expect(next.lines).toEqual([HAND_IT]);
    expect(next.links).toEqual(["/tickets"]);
    expect(next.blackButtons).toBe(0);
    // The message tells the assistant the same words for an empty list.
    expect(next.message).toContain(`"${HAND_IT.replace("Hand it a ticket: open", "Open")}"`);
    expect(next.message).toContain("Your Suggestions setting is Off.");
    // The link opens the ticket list.
    expect((await admin(next.app).get("/tickets")).status).toBe(200);
  });

  it("with Suggestions When asked, also says to file a ticket and press the proof step's button", async () => {
    const next = await nextPart("when_asked");
    expect(next.facts).toBe("Helper. Suggestions: When asked.");
    expect(next.lines).toEqual([
      HAND_IT,
      `Or let it suggest proofs: while your assistant is listening, file a ticket and press ${BUTTON_WORDS}.`,
    ]);
    expect(next.links).toEqual(["/tickets", "/tickets/new"]);
    expect(next.message).toContain("Your Suggestions setting is When asked.");
    // The new ticket form gives itself a one-time id first.
    const form = await admin(next.app).get("/tickets/new").redirects(1);
    expect(form.status).toBe(200);
    expect(form.text).toContain("File ticket");
  });

  it("with Suggestions Automatic, says to file a ticket while it listens", async () => {
    const next = await nextPart("automatic");
    expect(next.facts).toBe("Helper. Suggestions: Automatic.");
    expect(next.lines).toEqual([
      HAND_IT,
      "Or let it suggest proofs: while your assistant is listening, file a ticket.",
    ]);
    expect(next.message).toContain("Your Suggestions setting is Automatic.");
  });
});

describe("the page that shows a new key", () => {
  it("is one line, one box with one Copy button, and one sentence, then the closed fold", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
    const page = parse(res.text, { blockTextElements: { script: true, style: true } });
    const column = page.querySelector(".connection-created")!;
    const parts = column.childNodes
      .filter((node) => node.nodeType === 1)
      .map((node) => (node as typeof column).tagName);
    expect(parts).toEqual(["H1", "P", "P", "PRE", "BUTTON", "P", "P", "DIV", "DETAILS"]);
    expect(column.querySelector("h1")?.text).toBe("Connection issued");
    expect(column.querySelector("h1 + p")?.text).toBe("Helper. Suggestions: Off.");
    expect(column.querySelector("h1 + p + p")?.text).toBe("Paste this into your AI agent:");
    const button = column.querySelector("#agent-paste + button.copy")!;
    expect(button.getAttribute("data-copy")).toBe(page.querySelector("#agent-paste code")!.text);
    expect(button.getAttribute("aria-label")).toBe("Copy the message for your AI agent");
    expect(column.querySelector(".key-once")?.text).toBe(
      "The key is shown only once, on this page.",
    );
    expect(column.querySelector(".key-once + .reload-note")?.text).toBe(
      "Reloading this page issues another connection.",
    );
    const help = column.querySelector("details.connection-help")!;
    expect(help.hasAttribute("open")).toBe(false);
    expect(help.querySelector("summary")?.text).toBe("If that did not work");
    expect(help.querySelectorAll("pre.paste.command").map((p) => p.id)).toEqual([
      "claude-code",
      "mcp-json",
      "curl-command",
    ]);
    // Where to see what it did: each ticket's page, and this connection's own page.
    const href = help.querySelector(".see-what-it-wrote a")!.getAttribute("href")!;
    expect((await admin(app).get(href)).text).toContain("What it asked for");
    // Outside the fold, the key shows once: in the message.
    const outsideFold = column.text.replace(help.text, "");
    expect(outsideFold.split(keyOnPage(res.text))).toHaveLength(2);
  });

  it("gives the agent this site's page for assistants, the key, and its first job", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets"] });
    const message = parse(res.text, {
      blockTextElements: { script: true, style: true },
    }).querySelector("#agent-paste code")!.text;
    expect(message).toMatch(/Read http:\/\/127\.0\.0\.1(:\d+)?\/llms\.txt first\./);
    expect(message).toContain(`Authorization: Bearer ${keyOnPage(res.text)}`);
    expect(message).toMatch(/\/api\/tickets, and tell me what each one needs\./);
  });
});
