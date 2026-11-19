import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, buildTestApp } from "./helpers.js";
import { keyOnPage } from "./key-on-page.js";

// The page that shows a new key is one message to paste into an AI agent, one sentence about
// the key, and the manual setup folded away under "If that did not work".

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
    expect(parts).toEqual(["H1", "P", "PRE", "BUTTON", "P", "DETAILS"]);
    expect(column.querySelector("h1")?.text).toBe("Connection issued");
    expect(column.querySelector("h1 + p")?.text).toBe("Paste this into your AI agent:");
    const button = column.querySelector("#agent-paste + button.copy")!;
    expect(button.getAttribute("data-copy")).toBe(page.querySelector("#agent-paste code")!.text);
    expect(button.getAttribute("aria-label")).toBe("Copy the message for your AI agent");
    expect(column.querySelector(".key-once")?.text).toBe(
      "The key is shown only once, on this page.",
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
