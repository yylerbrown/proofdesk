import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import {
  labelFor,
  whenBroughtBack,
  wireSendLabel,
  type KindChoice,
  type SendButton,
} from "../src/browser/send-label.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The team's one message button names who will read the message: "Send reply to customer" or
// "Save internal note", by the choice above it. Without scripts it reads "Send".

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

/** The message box's send button on the ticket page, as this person sees it. */
async function sendButton(who: typeof teamActor) {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  const page = parse((await as(app, who).get("/tickets/SUP-1")).text);
  return page.querySelector("form.reply-box .reply-actions > button[type=submit]")!;
}

describe("the message button on the page", () => {
  it("carries both audience labels for the team, and reads Send without a script", async () => {
    const button = await sendButton(teamActor);
    expect(button.text).toBe("Send");
    expect(button.getAttribute("data-label-reply")).toBe("Send reply to customer");
    expect(button.getAttribute("data-label-note")).toBe("Save internal note");
  });

  it("says Send to the team for the customer, whose one audience is the team", async () => {
    const button = await sendButton(customerOne);
    expect(button.text).toBe("Send to the team");
    expect(button.hasAttribute("data-label-reply")).toBe(false);
  });
});

/** A stand-in radio button that keeps its change listener. */
function fakeChoice(value: string, checked: boolean) {
  let listener: () => void = () => undefined;
  const choice: KindChoice = {
    value,
    checked,
    defaultChecked: checked,
    addEventListener: (_type, given) => (listener = given),
  };
  return { choice, change: () => listener() };
}

describe("the script", () => {
  const labels = { labelReply: "Send reply to customer", labelNote: "Save internal note" };

  it("names the audience chosen when the page opens, and follows each change", () => {
    const button: SendButton = { dataset: { ...labels }, textContent: "Send" };
    const reply = fakeChoice("reply", true);
    const note = fakeChoice("note", false);
    wireSendLabel(button, [reply.choice, note.choice]);
    expect(button.textContent).toBe("Send reply to customer");

    reply.choice.checked = false;
    note.choice.checked = true;
    note.change();
    expect(button.textContent).toBe("Save internal note");

    note.choice.checked = false;
    reply.choice.checked = true;
    reply.change();
    expect(button.textContent).toBe("Send reply to customer");
  });

  it("leaves the button alone when it has no labels or nothing is chosen", () => {
    expect(labelFor({ dataset: {}, textContent: "Send" }, "note")).toBeNull();
    expect(labelFor({ dataset: { ...labels }, textContent: "Send" }, undefined)).toBeNull();
    const button: SendButton = { dataset: { ...labels }, textContent: "Send" };
    wireSendLabel(button, [fakeChoice("reply", false).choice]);
    expect(button.textContent).toBe("Send");
  });

  it("puts the choice back to the page's own when the page comes back, and the button with it", () => {
    const button: SendButton = { dataset: { ...labels }, textContent: "Send" };
    const reply = fakeChoice("reply", true);
    const note = fakeChoice("note", false);
    const backToPage = wireSendLabel(button, [reply.choice, note.choice]);
    // The person chose Internal note, then the browser brought the page back with that choice.
    reply.choice.checked = false;
    note.choice.checked = true;
    note.change();
    backToPage();
    expect(reply.choice.checked).toBe(true);
    expect(note.choice.checked).toBe(false);
    expect(button.textContent).toBe("Send reply to customer");
  });
});

describe("the reset when a page is shown", () => {
  it("runs only for a page brought back from the browser's cache, not on a fresh load", () => {
    let resets = 0;
    const listener = whenBroughtBack(() => (resets += 1));
    listener({ persisted: false });
    expect(resets).toBe(0);
    listener({ persisted: true });
    expect(resets).toBe(1);
  });
});

describe("the message box's choice of who sees it", () => {
  it("asks the browser not to fill it in from an earlier visit", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const radios = page.querySelectorAll("form.reply-box input[type=radio][name=kind]");
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(radio.getAttribute("autocomplete")).toBe("off");
  });
});
