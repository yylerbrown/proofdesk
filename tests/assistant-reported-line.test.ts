import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { admin, as, buildTestApp, customerOne, handToAgent, teamActor } from "./helpers.js";

// On a ticket an assistant worked, the team reads what it reported before the step that
// resolves: one grey line above the next step, with the latest piece's one-line result, linking
// to the evidence, which then shows unfolded. Only for the team, only until it is resolved, and
// only when an assistant attached something.

const valid = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };

async function worked() {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const page = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "attach_evidence"] });
  const key = keyOnPage(page.text);
  await handToAgent(app, "SUP-1", key);
  const attach = (body: object) =>
    request(app)
      .post("/api/tickets/SUP-1/evidence")
      .set("Authorization", `Bearer ${key}`)
      .send(body);
  return { app, attach };
}

const ticketPage = async (app: Express, who: typeof teamActor, address = "/tickets/SUP-1") =>
  parse((await as(app, who).get(address)).text);

describe("the line saying what the assistant reported", () => {
  it("sits above the next step with the latest result, with no suggested test open", async () => {
    const { app, attach } = await worked();
    expect((await attach({ kind: "test", summary: "First run", result: "1 failed" })).status).toBe(
      201,
    );
    await attach({ kind: "test", summary: "Second run", result: "3 passed, 0 failed\nmore" });
    const html = await ticketPage(app, teamActor);
    const lines = html.querySelectorAll(".card-reported");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text.trim()).toBe(
      "Reported by the assistant, not checked by Proofdesk: 3 passed, 0 failed",
    );
    // It is inside the step's card, straight above the step.
    expect(lines[0]!.closest(".ticket-card")).not.toBeNull();
    expect(lines[0]!.nextElementSibling?.classList.contains("next-action")).toBe(true);
    expect(lines[0]!.querySelector("a")?.getAttribute("href")).toBe(
      "/tickets/SUP-1?evidence=open#assistant-evidence",
    );
  });

  it("opens the folded evidence when followed", async () => {
    const { app, attach } = await worked();
    await attach({ kind: "test", summary: "Run", result: "3 passed" });
    const closed = (await ticketPage(app, teamActor)).querySelector("#assistant-evidence")!;
    expect(closed.hasAttribute("open")).toBe(false);
    const opened = (await ticketPage(app, teamActor, "/tickets/SUP-1?evidence=open")).querySelector(
      "#assistant-evidence",
    )!;
    expect(opened.hasAttribute("open")).toBe(true);
    expect(opened.text).toContain("3 passed");
  });

  it("uses the summary when the latest piece has no result", async () => {
    const { app, attach } = await worked();
    await attach({
      kind: "check_run",
      summary: "Checked the print queue",
      link: "https://a.test/",
    });
    const line = (await ticketPage(app, teamActor)).querySelector(".card-reported")!;
    expect(line.text.trim()).toBe(
      "Reported by the assistant, not checked by Proofdesk: Checked the print queue",
    );
  });

  it("is absent with no assistant evidence, for the customer, and once resolved", async () => {
    const { app, attach } = await worked();
    expect((await ticketPage(app, teamActor)).querySelector(".card-reported")).toBeNull();
    await attach({ kind: "test", summary: "Run", result: "MARK-RESULT" });
    const customer = await ticketPage(app, customerOne);
    expect(customer.querySelector(".card-reported")).toBeNull();
    expect(customer.toString()).not.toContain("MARK-RESULT");
    const resolved = await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "other", note: "Not ours." });
    expect(resolved.status).toBe(200);
    expect((await ticketPage(app, teamActor)).querySelector(".card-reported")).toBeNull();
  });
});
