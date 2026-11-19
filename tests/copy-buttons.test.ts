import { parse, type HTMLElement } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { wireCopyButtons, type CopyButton } from "../src/browser/copy.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// A Copy button beside every command, prompt or key meant to be pasted, carrying the exact text
// it copies. Hidden until the script runs, so with scripts off the text is simply selectable.

/** Reads a page, with code blocks as elements rather than raw text. */
const read = (text: string) => parse(text, { blockTextElements: { script: true, style: true } });

/** Each copy button on a page, and the text shown just before it (a code block or a key). */
function copies(html: HTMLElement) {
  return html.querySelectorAll("button.copy").map((button) => {
    const before = button.previousElementSibling!;
    const shown =
      before.querySelector("input.key")?.getAttribute("value") ??
      before.querySelector("code")?.text ??
      before.text;
    return {
      copies: button.getAttribute("data-copy"),
      shown,
      hidden: button.hasAttribute("hidden"),
    };
  });
}

describe("the copy script", () => {
  it("shows each button, copies its exact text, and says Copied for a moment", async () => {
    const written: string[] = [];
    const pending: (() => void)[] = [];
    let click = () => {};
    const button: CopyButton = {
      dataset: { copy: 'claude mcp add --header "Authorization: Bearer pd_x"' },
      hidden: true,
      textContent: "Copy",
      addEventListener: (_type, listener) => (click = listener),
    };
    wireCopyButtons([button], { writeText: async (text) => void written.push(text) }, (done) =>
      pending.push(done),
    );
    expect(button.hidden).toBe(false);
    click();
    await Promise.resolve();
    await Promise.resolve();
    expect(written).toEqual(['claude mcp add --header "Authorization: Bearer pd_x"']);
    expect(button.textContent).toBe("Copied");
    pending.forEach((done) => done());
    expect(button.textContent).toBe("Copy");
  });

  it("says what happened in a status line too, which a named button needs", async () => {
    const clicks: (() => void)[] = [];
    const make = (copy: string): CopyButton => ({
      dataset: { copy },
      hidden: true,
      textContent: "Copy",
      addEventListener: (_type, listener) => void clicks.push(listener),
    });
    const status = { textContent: "" as string | null };
    let allow = true;
    wireCopyButtons(
      [make("pd_x"), make("claude mcp add")],
      { writeText: () => (allow ? Promise.resolve() : Promise.reject(new Error("denied"))) },
      () => {},
      status,
    );
    // The line exists before any click, empty, so its first message is announced.
    expect(status.textContent).toBe("");
    clicks[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(status.textContent).toBe("Copied");
    allow = false;
    clicks[1]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(status.textContent).toBe("Select the text to copy");
  });

  it("says to select the text by hand when the browser refuses to copy", async () => {
    let click = () => {};
    const button: CopyButton = {
      dataset: { copy: "pd_x" },
      hidden: true,
      textContent: "Copy",
      addEventListener: (_type, listener) => (click = listener),
    };
    wireCopyButtons([button], { writeText: () => Promise.reject(new Error("denied")) }, () => {});
    click();
    await Promise.resolve();
    await Promise.resolve();
    expect(button.textContent).toBe("Select the text to copy");
  });

  it("is loaded on every page, from this site", async () => {
    const { app } = buildTestApp();
    const html = parse((await visitor(app).get("/sign-in")).text);
    expect(html.querySelector("script[src='/assets/js/copy.js']")).not.toBeNull();
  });
});

describe("copy buttons on the pages", () => {
  it("sit beside the key, the Claude Code command and the curl example, each with its exact text", async () => {
    const { app } = buildTestApp();
    const page = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets"] });
    const html = read(page.text);
    const found = copies(html);
    expect(found).toHaveLength(4);
    for (const item of found) {
      expect(item.copies).toBe(item.shown);
      expect(item.hidden).toBe(true);
    }
    expect(found[0]!.copies).toMatch(/^pd_/);
    expect(found[1]!.copies).toMatch(/^claude mcp add --transport http proofdesk /);
    // The .mcp.json entry carries the real key, ready to paste.
    const entry = JSON.parse(found[2]!.copies!) as {
      mcpServers: { proofdesk: { type: string; headers: { Authorization: string } } };
    };
    expect(entry.mcpServers.proofdesk.type).toBe("http");
    expect(entry.mcpServers.proofdesk.headers.Authorization).toBe(`Bearer ${found[0]!.copies}`);
    expect(found[3]!.copies).toMatch(/^curl -H "Authorization: Bearer pd_/);
    // Each is named for what it copies, so four buttons are not four times "Copy".
    expect(html.querySelectorAll("button.copy").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Copy the key",
      "Copy the Claude Code command",
      "Copy the .mcp.json entry",
      "Copy the curl command",
    ]);
  });

  it("sit beside the demo key's command too", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix);
    seedDemo(service);
    const found = copies(read((await visitor(built.app).post("/demo/connection")).text));
    expect(found.length).toBe(5);
    for (const item of found) expect(item.copies).toBe(item.shown);
    // The seed records the sample's key, so no test names a fixed number for it.
    expect(found[2]!.copies).toBe(
      `Using Proofdesk, write a test spec for ${service.assistantSampleKey()}`,
    );
  });

  it("sits beside the prompt that asks an assistant for a test spec", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x", fix_check: "Ten pages print" });
    const found = copies(read((await as(app, teamActor).get("/tickets/SUP-1")).text));
    expect(found).toEqual([
      {
        copies: "Using Proofdesk, write a test spec for SUP-1",
        shown: "Using Proofdesk, write a test spec for SUP-1",
        hidden: true,
      },
    ]);
  });
});
