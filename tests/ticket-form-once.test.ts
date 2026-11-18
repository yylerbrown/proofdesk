import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, customerTwo } from "./helpers.js";

// Going Back after filing shows the same form again, and pressing "File ticket" a second time
// must not file a copy. Each new form carries a one-time id in its address, and a form id
// files at most one ticket for the person who used it.

const typed = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
  where_url: "https://example.com/print",
};

/** Opens a new ticket form the way a browser does, and returns its address and its form id. */
async function openForm(app: Express, who = customerOne, address = "/tickets/new") {
  const first = await as(app, who).get(address);
  expect(first.status).toBe(303);
  const to = first.headers.location as string;
  const res = await as(app, who).get(to);
  expect(res.status).toBe(200);
  const html = parse(res.text);
  const formId = html.querySelector("form input[name=form]")?.getAttribute("value") ?? "";
  return { to, formId, html };
}

const file = (app: Express, body: Record<string, string>, who = customerOne) =>
  as(app, who).post("/tickets").type("form").send(body);

async function ticketKeys(app: Express): Promise<string[]> {
  const list = await admin(app).get("/api/tickets");
  return list.body.map((ticket: { key: string }) => ticket.key);
}

describe("the new ticket form's one-time id", () => {
  it("is put in the form's address and sent with the form, and is new for every form", async () => {
    const { app } = buildTestApp();
    const one = await openForm(app);
    const two = await openForm(app);
    expect(one.to).toMatch(/^\/tickets\/new\?form=[A-Za-z0-9_-]{22}$/);
    expect(one.to).toBe(`/tickets/new?form=${one.formId}`);
    expect(two.formId).not.toBe(one.formId);
    // A form id that is not one of ours gets a fresh one.
    const odd = await as(app, customerOne).get("/tickets/new?form=guess");
    expect(odd.headers.location).toMatch(/^\/tickets\/new\?form=[A-Za-z0-9_-]{22}$/);
  });

  it("keeps the demo's sample, so the ticket workflow still starts filled in", async () => {
    const { app } = buildTestApp();
    const res = await as(app, customerOne).get("/tickets/new?try=1");
    expect(res.headers.location).toMatch(/^\/tickets\/new\?try=1&form=[A-Za-z0-9_-]{22}$/);
  });
});

describe("sending the same form twice", () => {
  it("files one ticket, and the second send opens it and says it was already filed", async () => {
    const { app } = buildTestApp();
    const { formId } = await openForm(app);
    const first = await file(app, { ...typed, form: formId });
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/tickets/SUP-1");

    const again = await file(app, { ...typed, form: formId });
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe("/tickets/SUP-1");
    expect(await ticketKeys(app)).toEqual(["SUP-1"]);

    expect(String(again.headers["set-cookie"])).toMatch(/(^|,)saved=alreadyFiled;/);
    const opened = await as(app, customerOne)
      .get("/tickets/SUP-1")
      .set("Cookie", `dev_actor=${customerOne.id}; saved=alreadyFiled`);
    const shown = parse(opened.text);
    expect(shown.querySelector("p.saved")?.text).toBe(
      "You already filed this form, so nothing new was filed. This is that ticket.",
    );
  });

  it("opens the filed ticket when the same text with line breaks is sent again", async () => {
    // A browser sends each line break in a text box as "\r\n", and filing stores "\n".
    const { app } = buildTestApp();
    const { formId } = await openForm(app);
    const lines = {
      ...typed,
      description: "It jams on page two.\r\nThen it stops.",
      fix_check: "Ten pages print\r\nNo jam light",
      form: formId,
    };
    expect((await file(app, lines)).headers.location).toBe("/tickets/SUP-1");

    const again = await file(app, lines);
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe("/tickets/SUP-1");
    expect(String(again.headers["set-cookie"])).toMatch(/(^|,)saved=alreadyFiled;/);
    expect(await ticketKeys(app)).toEqual(["SUP-1"]);
  });

  it("says on the form, when it is opened again after filing, which ticket it filed", async () => {
    const { app } = buildTestApp();
    const { to, formId, html } = await openForm(app);
    expect(html.querySelector(".already-filed")).toBeNull();
    await file(app, { ...typed, form: formId });

    const back = parse((await as(app, customerOne).get(to)).text);
    const note = back.querySelector(".already-filed");
    expect(note?.text).toBe("This form was already filed as SUP-1. Start a new ticket.");
    expect(note?.querySelectorAll("a").map((a) => a.getAttribute("href"))).toEqual([
      "/tickets/SUP-1",
      "/tickets/new",
    ]);
  });

  it("files nothing when the text was changed, and shows the form again with the new text", async () => {
    const { app } = buildTestApp();
    const { formId } = await openForm(app);
    await file(app, { ...typed, form: formId });

    const changed = await file(app, { ...typed, title: "Printer still jams", form: formId });
    expect(changed.status).toBe(409);
    const html = parse(changed.text);
    expect(html.querySelector("input[name=title]")?.getAttribute("value")).toBe(
      "Printer still jams",
    );
    expect(html.querySelector("textarea[name=description]")?.text).toBe(typed.description);
    expect(html.querySelector(".already-filed a")?.getAttribute("href")).toBe("/tickets/SUP-1");
    expect(await ticketKeys(app)).toEqual(["SUP-1"]);
  });

  it("can still file after a refused first try, since a refusal stores nothing", async () => {
    const { app } = buildTestApp();
    const { formId } = await openForm(app);
    const refused = await file(app, { ...typed, title: "No", form: formId });
    expect(refused.status).toBe(400);
    // The refused form keeps its id, so its next send is still the same form.
    expect(parse(refused.text).querySelector("input[name=form]")?.getAttribute("value")).toBe(
      formId,
    );
    expect((await file(app, { ...typed, form: formId })).headers.location).toBe("/tickets/SUP-1");
    expect((await file(app, { ...typed, form: formId })).headers.location).toBe("/tickets/SUP-1");
    expect(await ticketKeys(app)).toEqual(["SUP-1"]);
  });
});

describe("a form id belongs to the person who used it", () => {
  it("tells another person nothing about it, and files their own ticket", async () => {
    const { app } = buildTestApp();
    const { to, formId } = await openForm(app, customerOne);
    await file(app, { ...typed, form: formId }, customerOne);

    const theirs = parse((await as(app, customerTwo).get(to)).text);
    expect(theirs.querySelector(".already-filed")).toBeNull();
    expect(theirs.text).not.toContain("SUP-1");
    const filed = await file(app, { ...typed, form: formId }, customerTwo);
    expect(filed.headers.location).toBe("/tickets/SUP-2");
    expect(await ticketKeys(app)).toEqual(["SUP-2", "SUP-1"]);
  });

  it("is not needed: a form sent without one files as before", async () => {
    const { app } = buildTestApp();
    await file(app, typed);
    await file(app, typed);
    expect(await ticketKeys(app)).toEqual(["SUP-2", "SUP-1"]);
  });
});
