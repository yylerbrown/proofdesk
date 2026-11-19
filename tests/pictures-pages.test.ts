import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { DEMO_BUDGET, seedDemo } from "../src/server/demo.js";
import { samplePicture } from "../src/server/pictures/sample.js";
import { SHOWN_ONLY_TO_UPLOADER } from "../src/server/pictures/limits.js";
import { createTicketService } from "../src/server/tickets/service.js";
import type { Actor } from "../src/server/actor.js";
import { messageRefusalLine, ticketFormPictureLine } from "../src/server/pages/picture-refusal.js";
import { addChosen, controlWords, removeLabel } from "../src/browser/pictures.js";
import {
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  FROM_THIS_SITE,
  teamActor,
} from "./helpers.js";

// Pictures on the pages: the quiet "Add pictures" control on the new ticket form and in the
// message box, and the small squares under the words they came with. Everything here works with
// scripts off: the forms are plain multipart posts.

const PNG = samplePicture();
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const ticket = { title: "Printer jams", description: "On page two", fix_check: "Ten pages print" };

/** The new ticket form's address with its form id, as a browser lands on it. */
async function newFormPage(app: Express, who: Actor): Promise<string> {
  const first = await as(app, who).get("/tickets/new");
  expect(first.status).toBe(303);
  const page = await as(app, who).get(first.headers.location as string);
  expect(page.status).toBe(200);
  return page.text;
}

/** Files a ticket from the form as multipart, with these pictures. */
function fileWith(app: Express, who: Actor, pictures: Buffer[], values = ticket) {
  let post = as(app, who).post("/tickets");
  for (const [name, value] of Object.entries(values)) post = post.field(name, value);
  pictures.forEach((bytes, index) => {
    post = post.attach("pictures", bytes, `shot-${index + 1}.png`);
  });
  return post;
}

/** Writes a message from the ticket page's box as multipart, with these pictures. */
function writeWith(
  app: Express,
  who: Actor,
  kind: "reply" | "note",
  pictures: Buffer[],
  body = "Here is what I see.",
) {
  let post = as(app, who).post("/tickets/SUP-1/entries").field("kind", kind).field("body", body);
  pictures.forEach((bytes, index) => {
    post = post.attach("pictures", bytes, `message-${index + 1}.png`);
  });
  return post;
}

/** The ticket page's HTML for this person. */
async function ticketPage(app: Express, who: Actor) {
  return as(app, who).get("/tickets/SUP-1");
}

/** The alternative text of every thumbnail on a page, in page order. */
function thumbnails(html: string): string[] {
  return [...html.matchAll(/<img src="\/tickets\/SUP-1\/pictures\/\d+" alt="([^"]*)"/g)].map(
    (match) => match[1]!,
  );
}

describe("the Add pictures control", () => {
  it("is on the new ticket form, which is sent as multipart", async () => {
    const { app } = buildTestApp();
    const html = await newFormPage(app, customerOne);
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toMatch(
      /<span class="add-pictures-words">Add pictures<\/span><input type="file" name="pictures" accept="image\/png,image\/jpeg,image\/gif,image\/webp" multiple data-pictures-limit="4"/,
    );
    // Directly under the Description box, before the check.
    const description = html.indexOf('name="description"');
    const control = html.indexOf('name="pictures"');
    expect(control).toBeGreaterThan(description);
    expect(control).toBeLessThan(html.indexOf('name="fix_check"'));
    // No standing words about the limit or the file types.
    expect(html).not.toContain("PNG, JPEG");
  });

  it("is not on the edit form, which stays a plain post", async () => {
    const { app } = buildTestApp();
    await fileWith(app, customerOne, []);
    const html = (await as(app, customerOne).get("/tickets/SUP-1/edit")).text;
    expect(html).not.toContain('name="pictures"');
    expect(html).not.toContain("multipart/form-data");
  });

  it("sits on the message box's button row, straight after the send button", async () => {
    const { app } = buildTestApp();
    await fileWith(app, customerOne, []);
    for (const who of [customerOne, teamActor]) {
      const html = (await ticketPage(app, who)).text;
      const box = html.slice(html.indexOf('class="reply-box"'));
      expect(html).toMatch(/class="reply-box" enctype="multipart\/form-data"/);
      const row = box.slice(box.indexOf('class="reply-actions"'));
      expect(row.indexOf('type="submit"')).toBeLessThan(row.indexOf('name="pictures"'));
      // The strip for chosen pictures sits between the box and that row.
      expect(box.indexOf('id="reply-picture-strip"')).toBeLessThan(
        box.indexOf('class="reply-actions"'),
      );
    }
  });

  it("takes its number from the server's limits, so the demo's picker stops at two", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix, DEMO_BUDGET);
    seedDemo(service);
    const cookie = `${DEV_COOKIE}=demo-customer`;
    const first = await request(built.app).get("/tickets/new").set("Cookie", cookie);
    const page = await request(built.app)
      .get(first.headers.location as string)
      .set("Cookie", cookie);
    expect(page.text).toContain('data-pictures-limit="2"');
  });
});

describe("pictures sent with scripts off", () => {
  it("file a ticket whose pictures show under the description, before the check", async () => {
    const { app } = buildTestApp();
    const filed = await fileWith(app, customerOne, [PNG, JPEG]);
    expect(filed.status).toBe(303);
    const html = (await ticketPage(app, customerOne)).text;
    expect(thumbnails(html)).toEqual([
      "Picture 1 of 2 from Customer One",
      "Picture 2 of 2 from Customer One",
    ]);
    const description = html.indexOf("ticket-description");
    const pictures = html.indexOf('<div class="pictures">');
    expect(pictures).toBeGreaterThan(description);
    expect(pictures).toBeLessThan(html.indexOf("Ten pages print"));
    // Each opens the full picture in a new tab, and loads only when scrolled to.
    expect(html).toMatch(
      /<a href="\/tickets\/SUP-1\/pictures\/1" target="_blank" rel="noopener"><img src="\/tickets\/SUP-1\/pictures\/1" alt="Picture 1 of 2 from Customer One" width="80" height="80" loading="lazy" \/><\/a>/,
    );
  });

  it("add a message whose pictures show directly under its words", async () => {
    const { app } = buildTestApp();
    await fileWith(app, customerOne, []);
    const sent = await writeWith(app, teamActor, "reply", [PNG]);
    expect(sent.status).toBe(303);
    const html = (await ticketPage(app, customerOne)).text;
    const article = html.slice(html.indexOf('<article class="entry"'));
    expect(article.indexOf("Here is what I see.")).toBeLessThan(
      article.indexOf('<div class="pictures">'),
    );
    expect(article.indexOf('<div class="pictures">')).toBeLessThan(article.indexOf("</article>"));
    expect(thumbnails(html)).toEqual(["Picture 1 of 1 from Team Member"]);
  });
});

describe("who sees the thumbnails", () => {
  /** SUP-1 by customer one with a picture, a team reply with one and a team note with one. */
  async function threePictures() {
    const built = buildTestApp();
    await fileWith(built.app, customerOne, [PNG]);
    await writeWith(built.app, teamActor, "reply", [JPEG]);
    await writeWith(built.app, teamActor, "note", [PNG], "Only for us.");
    return built;
  }

  it("shows the filer the description's and the reply's, never the note's", async () => {
    const { app } = await threePictures();
    const html = (await ticketPage(app, customerOne)).text;
    expect(thumbnails(html)).toEqual([
      "Picture 1 of 1 from Customer One",
      "Picture 1 of 1 from Team Member",
    ]);
    expect(html).not.toContain("/tickets/SUP-1/pictures/3");
  });

  it("shows the team all three, the note's inside the note's own marking", async () => {
    const { app } = await threePictures();
    const html = (await ticketPage(app, teamActor)).text;
    expect(thumbnails(html)).toHaveLength(3);
    const note = html.slice(html.indexOf('<article class="entry note"'));
    const noteEnd = note.indexOf("</article>");
    expect(note.indexOf("/tickets/SUP-1/pictures/3")).toBeGreaterThan(0);
    expect(note.indexOf("/tickets/SUP-1/pictures/3")).toBeLessThan(noteEnd);
  });

  it("gives another customer nothing", async () => {
    const { app } = await threePictures();
    const page = await ticketPage(app, customerTwo);
    expect(page.status).toBe(404);
    expect(page.text).not.toContain("/pictures/");
  });
});

describe("a ticket without pictures", () => {
  it("draws nothing for pictures under the description or a message", async () => {
    const { app } = buildTestApp();
    await fileWith(app, customerOne, []);
    await writeWith(app, teamActor, "reply", []);
    const html = (await ticketPage(app, customerOne)).text;
    expect(html).not.toContain('class="pictures"');
    expect(html).not.toContain("picture-hidden");
    expect(html).not.toContain('<img src="/tickets/');
    // The strip for chosen pictures waits hidden and empty.
    expect(html).toContain('<div class="picture-strip" id="reply-picture-strip" hidden></div>');
  });
});

describe("a picture shown only to the visitor who added it, on the shared demo", () => {
  it("is one grey line for everyone else", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix, DEMO_BUDGET);
    seedDemo(service);
    const demoCustomer = DEMO_ACTORS.find((actor) => actor.id === "demo-customer")!;
    const own = service.listTickets("all", demoCustomer, 1);
    const key = own.find((one) => one.title === "Invoice shows the wrong date")!.key;
    const visitor = (cookie: string) => ({
      get: (address: string) =>
        request(built.app).get(address).set(FROM_THIS_SITE).set("Cookie", cookie),
      post: (address: string) =>
        request(built.app).post(address).set(FROM_THIS_SITE).set("Cookie", cookie),
    });
    const sent = await visitor(`${DEV_COOKIE}=demo-customer`)
      .post(`/tickets/${key}/entries`)
      .field("kind", "reply")
      .field("body", "This is what I see.")
      .attach("pictures", PNG, "mine.png");
    expect(sent.status).toBe(303);
    const token = [sent.headers["set-cookie"] ?? []]
      .flat()
      .find((line: string) => line.startsWith("demo_pictures="))!
      .split(";")[0]!;

    // The browser that added it sees its thumbnail.
    const mine = await visitor(`${DEV_COOKIE}=demo-customer; ${token}`).get(`/tickets/${key}`);
    expect(mine.text).toMatch(/alt="Picture 1 of 1 from Demo Customer"/);
    expect(mine.text).not.toContain(SHOWN_ONLY_TO_UPLOADER);

    // Another browser, even as the same demo person, gets the line and no address.
    const other = await visitor(`${DEV_COOKIE}=demo-customer`).get(`/tickets/${key}`);
    expect(other.text).toContain(
      `<p class="picture-hidden"><small>${SHOWN_ONLY_TO_UPLOADER}</small></p>`,
    );
    expect(other.text).not.toMatch(/alt="Picture 1 of 1 from Demo Customer"/);
  });
});

describe("a refused post that carried pictures", () => {
  it("keeps the typed text on the new ticket form and names the limit", async () => {
    const { app } = buildTestApp();
    const refused = await fileWith(app, customerOne, [PNG, PNG, PNG, PNG, PNG]);
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('value="Printer jams"');
    expect(refused.text).toContain(
      '<small id="pictures-error" class="picture-refused">Attach at most 4 pictures at a time. Choose the pictures again.</small>',
    );
    // The control is marked and takes focus, since it is the one thing to fix.
    expect(refused.text).toMatch(/name="pictures"[^>]*aria-invalid="true"[^>]*autofocus/);
  });

  it("says the pictures were not saved when the form was refused for something else", async () => {
    const { app } = buildTestApp();
    const refused = await fileWith(app, customerOne, [PNG], { ...ticket, title: "No" });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("The pictures were not saved. Choose the pictures again.");
  });

  it("says nothing about pictures when none were chosen", async () => {
    const { app } = buildTestApp();
    const refused = await fileWith(app, customerOne, [], { ...ticket, title: "No" });
    expect(refused.status).toBe(400);
    expect(refused.text).not.toContain("Choose the pictures again.");
  });

  it("keeps the message and names the limit in the message box", async () => {
    const { app } = buildTestApp();
    await fileWith(app, customerOne, []);
    const refused = await writeWith(app, customerOne, "reply", [PNG, PNG, PNG, PNG, PNG], "Mine");
    expect(refused.status).toBe(400);
    expect(refused.text).toContain(
      '<small id="body-error">Attach at most 4 pictures at a time. Choose the pictures again.</small>',
    );
    expect(refused.text).toMatch(/<textarea id="entry-body"[^>]*>Mine<\/textarea>/);
  });

  it("says a message needs words as well as pictures", async () => {
    const { app } = buildTestApp();
    await fileWith(app, customerOne, []);
    const refused = await writeWith(app, customerOne, "reply", [PNG], "");
    expect(refused.status).toBe(400);
    expect(refused.text).toContain(
      "A message needs words as well as pictures. Choose the pictures again.",
    );
  });
});

describe("the refusal lines", () => {
  it("name the limit, or say the pictures were not kept, and always say to choose again", () => {
    expect(ticketFormPictureLine("Each picture must be at most 2 MB.", true)).toBe(
      "Each picture must be at most 2 MB. Choose the pictures again.",
    );
    expect(ticketFormPictureLine(undefined, true)).toBe(
      "The pictures were not saved. Choose the pictures again.",
    );
    expect(ticketFormPictureLine(undefined, false)).toBeNull();
    expect(messageRefusalLine("Must not be empty.", undefined, false, "")).toBe(
      "Must not be empty.",
    );
    expect(messageRefusalLine("Must be at most 5000 characters.", undefined, true, "x")).toBe(
      "Must be at most 5000 characters. The pictures were not saved. Choose the pictures again.",
    );
  });
});

describe("the picture script's rules", () => {
  const file = (name: string, type = "image/png") => ({ name, type });

  it("reads Add pictures until the limit, then the count", () => {
    expect(controlWords(0, 4)).toBe("Add pictures");
    expect(controlWords(3, 4)).toBe("Add pictures");
    expect(controlWords(4, 4)).toBe("4 of 4 pictures");
    expect(controlWords(2, 2)).toBe("2 of 2 pictures");
  });

  it("adds new pictures after the chosen ones, up to the limit, and skips other files", () => {
    const kept = [file("a.png")];
    const added = addChosen(
      kept,
      [
        file("notes.txt", "text/plain"),
        file("b.jpg", "image/jpeg"),
        file("c.svg", "image/svg+xml"),
      ],
      4,
    );
    expect(added.map((one) => one.name)).toEqual(["a.png", "b.jpg"]);
    const many = ["1", "2", "3", "4", "5"].map((name) => file(`${name}.png`));
    expect(addChosen(kept, many, 4).map((one) => one.name)).toEqual([
      "a.png",
      "1.png",
      "2.png",
      "3.png",
    ]);
  });

  it("names each remove button for its file", () => {
    expect(removeLabel("settings.png")).toBe("Remove settings.png");
  });
});
