import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, FROM_THIS_SITE, teamActor } from "./helpers.js";

// Marking a ticket fixed is the team's word that what would prove it is fixed was met. The
// customer's words are said once, in one grey sentence right above the press, and History says
// the team agreed to them. A person's evidence goes in the conversation, not in a form of its own.

const withProof = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };
const withoutProof = { title: "Printer jams", description: "x" };

/** A ticket customer one filed, which the team member has taken and started. */
async function inProgress(ticket: object) {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(ticket).expect(201);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start").expect(200);
  return app;
}

async function page(app: Awaited<ReturnType<typeof inProgress>>, address = "/tickets/SUP-1") {
  return parse((await as(app, teamActor).get(address)).text);
}

/** History's What column, top to bottom. */
function historyWhat(html: ReturnType<typeof parse>): string[] {
  return html
    .querySelectorAll("details.history tbody tr")
    .map((row) => row.querySelectorAll("td")[1]!.text);
}

describe("the next step Mark fixed and tell the customer", () => {
  it("says above its button that the press agrees the proof was met, and says the proof once", async () => {
    const app = await inProgress(withProof);
    const html = await page(app);
    const step = html.querySelector(".ticket-card .next-action")!;
    const oath = step.querySelector(".next-oath")!;
    expect(oath.text).toBe('By marking it fixed, you agree this is met: "Ten pages print"');
    // The proof is the customer's own text, drawn as user text.
    expect(oath.querySelector(".user-text")?.text).toBe("Ten pages print");
    // Directly above the button, and still one press with no tick box.
    expect(oath.nextElementSibling?.tagName).toBe("FORM");
    expect(step.querySelector("button")?.text).toBe("Mark fixed and tell the customer");
    expect(step.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    // Said once: the card's label and quote do not also show while this step does.
    const card = html.querySelector(".ticket-card")!;
    expect(card.querySelector(".card-label")).toBeNull();
    expect(card.querySelector("blockquote")).toBeNull();
    expect(html.querySelector("main")!.text.split("Ten pages print")).toHaveLength(2);
  });

  it("adds nothing on a ticket that does not say what would prove it is fixed", async () => {
    const app = await inProgress(withoutProof);
    const html = await page(app);
    expect(html.querySelector(".next-action button")?.text).toBe(
      "Mark fixed and tell the customer",
    );
    expect(html.querySelector(".next-oath")).toBeNull();
    expect(html.querySelector("main")!.text).not.toContain("you agree this is met");
  });

  it("leaves the proof where it is for the customer and before the step shows", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(withProof).expect(201);
    // New: the step is "Take ticket and start work", and the card keeps the proof.
    const team = await page(app);
    expect(team.querySelector(".ticket-card .card-label")?.text).toBe(
      "What would prove it is fixed?",
    );
    expect(team.querySelector(".ticket-card blockquote")?.text).toBe("Ten pages print");
    expect(team.querySelector(".next-oath")).toBeNull();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start").expect(200);
    const customer = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(customer.querySelector(".ticket-card blockquote")?.text).toBe("Ten pages print");
    expect(customer.querySelector(".next-oath")).toBeNull();
  });

  it("shows the same sentence in the Status menu's Resolved form, in its Fixed part", async () => {
    const app = await inProgress(withProof);
    const form = (await page(app, "/tickets/SUP-1?step=resolve")).querySelector("form.resolve")!;
    const oath = form.querySelector(".resolve-oath")!;
    // The stylesheet shows .resolve-fixed-in only while Fixed is chosen.
    expect(oath.classList.contains("resolve-fixed-in")).toBe(true);
    expect(oath.text).toBe('By marking it fixed, you agree this is met: "Ten pages print"');
    expect(oath.nextElementSibling?.classList.contains("resolve-fixed-in")).toBe(true);
    const bare = await inProgress(withoutProof);
    const plain = (await page(bare, "/tickets/SUP-1?step=resolve")).querySelector("form.resolve")!;
    expect(plain.querySelector(".resolve-oath")).toBeNull();
  });
});

describe("History after marking it fixed", () => {
  it("says the team agreed the proof was met, with where it is fixed kept", async () => {
    const app = await inProgress(withProof);
    await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .set(FROM_THIS_SITE)
      .type("form")
      .send({ reason: "fixed_no_reply", fixed_in: "version 4.2", expected_version: "" })
      .expect(303);
    expect(historyWhat(await page(app))).toContain(
      "Resolved by the team: Fixed. Agreed that what would prove it is fixed was met. Not customer-confirmed. Fixed in: version 4.2.",
    );
  });

  it("reads as before on a ticket that had no proof when it was marked fixed", async () => {
    const app = await inProgress(withoutProof);
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "fixed_no_reply" })
      .expect(200);
    const before = historyWhat(await page(app));
    expect(before).toContain("Resolved by the team: Fixed. Not customer-confirmed.");
    // The customer reopens it and only then writes what would prove it: the earlier resolve
    // agreed to nothing.
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "Still jams." })
      .expect(200);
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/check")
      .send({ words: "Ten pages print" })
      .expect(200);
    const after = historyWhat(await page(app));
    expect(after).toContain("Resolved by the team: Fixed. Not customer-confirmed.");
    expect(after.join(" ")).not.toContain("Agreed that");
  });

  it("does not say the proof was agreed when it was written later through an edit", async () => {
    const app = await inProgress(withoutProof);
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "fixed_no_reply" })
      .expect(200);
    // The customer then edits the ticket and adds what would prove it.
    const read = await as(app, customerOne).get("/api/tickets/SUP-1").expect(200);
    await as(app, customerOne)
      .put("/api/tickets/SUP-1")
      .send({ ...withProof, expected_version: read.body.version })
      .expect(200);
    const rows = historyWhat(await page(app));
    expect(rows).toContain("Resolved by the team: Fixed. Not customer-confirmed.");
    expect(rows.join(" ")).not.toContain("Agreed that");
  });

  it("leaves the team's other reasons as they read today", async () => {
    const app = await inProgress(withProof);
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "wont_fix" })
      .expect(200);
    const rows = historyWhat(await page(app));
    expect(rows).toContain("Resolved by the team: Won't fix");
    expect(rows.join(" ")).not.toContain("Agreed that");
  });
});

describe("short text boxes", () => {
  it("ask the browser not to fill them in from earlier visits", async () => {
    const app = await inProgress(withProof);
    const list = parse((await as(app, teamActor).get("/tickets")).text);
    expect(list.querySelector("input[name=q]")?.getAttribute("autocomplete")).toBe("off");
    const form = (await page(app, "/tickets/SUP-1?step=resolve")).querySelector("form.resolve")!;
    for (const name of ["duplicate_of", "fixed_in"]) {
      expect(form.querySelector(`input[name=${name}]`)?.getAttribute("autocomplete"), name).toBe(
        "off",
      );
    }
  });
});
