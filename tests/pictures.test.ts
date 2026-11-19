import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  handToAgent,
  teamActor,
} from "./helpers.js";
import type { Actor } from "../src/server/actor.js";
import { createConnectionService } from "../src/server/connections/service.js";
import { ValidationError } from "../src/server/errors.js";
import { pictureTypeOf } from "../src/server/pictures/kinds.js";
import {
  PICTURE_LIMITS,
  PICTURE_REFUSALS,
  type PictureLimits,
} from "../src/server/pictures/limits.js";
import { samplePicture } from "../src/server/pictures/sample.js";
import { createTicketService } from "../src/server/tickets/service.js";

// Pictures on tickets: a customer files a ticket with a screenshot, and anyone writing a reply or
// a note can add one. A picture is seen by exactly who sees what it is attached to.

const PNG = samplePicture();
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(64)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.alloc(4),
  Buffer.from("WEBPVP8 ", "latin1"),
  Buffer.alloc(64),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
const HTML = Buffer.from("<!doctype html><title>x</title><p>not a picture</p>");
const TEXT = Buffer.from("Just some notes, saved as a text file.");

const ticket = { title: "Printer jams", description: "On page two", fix_check: "Ten pages print" };

type Picture = [bytes: Buffer, name: string];

/** Files a ticket from the new-ticket form as multipart, the way a browser sends it. */
function fileWith(app: Express, who: Actor, pictures: Picture[], values = ticket) {
  let post = as(app, who).post("/tickets");
  for (const [name, value] of Object.entries(values)) post = post.field(name, value);
  for (const [bytes, name] of pictures) post = post.attach("pictures", bytes, name);
  return post;
}

/** Writes a reply or a note from the ticket page's message box, as multipart. */
function writeWith(
  app: Express,
  who: Actor,
  key: string,
  kind: "reply" | "note",
  pictures: Picture[],
  body = "Here is what I see.",
) {
  let post = as(app, who).post(`/tickets/${key}/entries`).field("kind", kind).field("body", body);
  for (const [bytes, name] of pictures) post = post.attach("pictures", bytes, name);
  return post;
}

/** Every picture this person is listed on the ticket, description first, from the JSON API. */
async function listed(app: Express, who: Actor, key: string) {
  const read = await as(app, who).get(`/api/tickets/${key}`);
  if (read.status !== 200) return null;
  const entries = await as(app, who).get(`/api/tickets/${key}/entries`);
  const fromEntries = (entries.body as { pictures: { id: number }[] }[]).flatMap(
    (entry) => entry.pictures,
  );
  return [...(read.body.pictures as { id: number }[]), ...fromEntries].map((p) => p.id);
}

function pictureRows(db: ReturnType<typeof buildTestApp>["db"]): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ticket_pictures").get() as { n: number }).n;
}

describe("the type of a picture", () => {
  it("is read from its first bytes, never from its name", () => {
    expect(pictureTypeOf(PNG)).toBe("image/png");
    expect(pictureTypeOf(JPEG)).toBe("image/jpeg");
    expect(pictureTypeOf(GIF)).toBe("image/gif");
    expect(pictureTypeOf(WEBP)).toBe("image/webp");
    expect(pictureTypeOf(SVG)).toBeNull();
    expect(pictureTypeOf(HTML)).toBeNull();
    expect(pictureTypeOf(TEXT)).toBeNull();
    expect(pictureTypeOf(Buffer.alloc(0))).toBeNull();
  });
});

describe("filing a ticket with pictures", () => {
  it("works as a plain multipart form post, with no script on the page", async () => {
    const { app } = buildTestApp();
    const filed = await fileWith(app, customerOne, [
      [PNG, "screen.png"],
      [JPEG, "photo.jpg"],
    ]);
    expect(filed.status).toBe(303);
    expect(filed.headers.location).toBe("/tickets/SUP-1");
    const read = await as(app, customerOne).get("/api/tickets/SUP-1");
    expect(read.body.title).toBe("Printer jams");
    expect(read.body.pictures).toEqual([
      expect.objectContaining({ entry_id: null, type: "image/png", size: PNG.length }),
      expect.objectContaining({ entry_id: null, type: "image/jpeg", size: JPEG.length }),
    ]);
    const loaded = await as(app, customerOne).get(read.body.pictures[0].url);
    expect(loaded.status).toBe(200);
    expect(Buffer.compare(loaded.body as Buffer, PNG)).toBe(0);
  });

  it("still takes the plain form post, with no pictures", async () => {
    const { app } = buildTestApp();
    const filed = await as(app, customerOne).post("/tickets").type("form").send(ticket);
    expect(filed.status).toBe(303);
    expect((await as(app, customerOne).get("/api/tickets/SUP-1")).body.pictures).toEqual([]);
  });

  it("takes a form whose picture box was left empty", async () => {
    const { app, db } = buildTestApp();
    const filed = await fileWith(app, customerOne, [[Buffer.alloc(0), ""]]);
    expect(filed.status).toBe(303);
    expect(pictureRows(db)).toBe(0);
  });
});

describe("a refused picture", () => {
  const refusals: [string, Picture[], string][] = [
    ["a text file renamed .png", [[TEXT, "notes.png"]], "must be a PNG, JPEG, GIF or WebP"],
    ["an SVG", [[SVG, "drawing.svg"]], "must be a PNG, JPEG, GIF or WebP"],
    ["an HTML file named .png", [[HTML, "page.png"]], "must be a PNG, JPEG, GIF or WebP"],
    [
      "one over 2 MB",
      [[Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]), "big.png"]],
      "at most 2 MB",
    ],
    ["five at once", Array(5).fill([PNG, "a.png"]) as Picture[], "at most 4 pictures at a time"],
  ];

  for (const [what, pictures, sentence] of refusals) {
    // The form receives the sentence as errors.pictures; the form's picture box shows it.
    it(`refuses the whole ticket and keeps what was typed: ${what}`, async () => {
      const { app, db } = buildTestApp();
      const filed = await fileWith(app, customerOne, pictures);
      expect(filed.status).toBe(400);
      expect(filed.text).toContain('value="Printer jams"');
      expect((await as(app, customerOne).get("/api/tickets")).body).toEqual([]);
      expect(pictureRows(db)).toBe(0);
    });

    it(`refuses the whole message and keeps what was typed: ${what}`, async () => {
      const { app, db } = buildTestApp();
      await as(app, customerOne).post("/api/tickets").send(ticket);
      const sent = await writeWith(app, customerOne, "SUP-1", "reply", pictures, "My own words");
      expect(sent.status).toBe(400);
      expect(sent.text).toContain(sentence);
      expect(sent.text).toContain("My own words");
      expect((await as(app, customerOne).get("/api/tickets/SUP-1/entries")).body).toEqual([]);
      expect(pictureRows(db)).toBe(0);
    });
  }

  it("refuses more than 20 pictures on one ticket", async () => {
    const { app, db } = buildTestApp();
    const four = Array(4).fill([PNG, "a.png"]) as Picture[];
    await fileWith(app, customerOne, four);
    for (let message = 0; message < 4; message += 1) {
      expect((await writeWith(app, customerOne, "SUP-1", "reply", four)).status).toBe(303);
    }
    expect(pictureRows(db)).toBe(20);
    const over = await writeWith(app, customerOne, "SUP-1", "reply", [[PNG, "a.png"]], "One more");
    expect(over.status).toBe(400);
    expect(over.text).toContain("A ticket holds at most 20 pictures.");
    expect(pictureRows(db)).toBe(20);
  });

  it("is refused only after who is asking: someone else's ticket learns nothing of the rules", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(ticket);
    const sent = await writeWith(app, customerTwo, "SUP-1", "reply", [[TEXT, "notes.png"]]);
    expect(sent.status).toBe(404);
    expect(sent.text).not.toContain("PNG");
  });
});

describe("a reply or a note with pictures", () => {
  it("works as a plain multipart form post, and a plain post still works", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(ticket);
    const withPicture = await writeWith(app, teamActor, "SUP-1", "reply", [[GIF, "fix.gif"]]);
    expect(withPicture.status).toBe(303);
    expect(withPicture.headers.location).toBe("/tickets/SUP-1#sent");
    const plain = await as(app, teamActor)
      .post("/tickets/SUP-1/entries")
      .type("form")
      .send({ kind: "reply", body: "No picture this time." });
    expect(plain.status).toBe(303);
    const entries = (await as(app, customerOne).get("/api/tickets/SUP-1/entries")).body;
    expect(entries.map((entry: { pictures: unknown[] }) => entry.pictures.length)).toEqual([1, 0]);
    expect(entries[0].pictures[0]).toMatchObject({ entry_id: entries[0].id, type: "image/gif" });
  });

  it("keeps a message's history as one line, with no line of its own for the picture", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(ticket);
    await writeWith(app, teamActor, "SUP-1", "reply", [[GIF, "fix.gif"]]);
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
    expect(events.map((event) => event.type)).toEqual(["created", "reply_added"]);
  });
});

describe("who sees a picture", () => {
  /** SUP-1, filed by customer one with a picture, with a reply and a note that each have one. */
  async function threePictures() {
    const built = buildTestApp();
    const { app } = built;
    await fileWith(app, customerOne, [[PNG, "what-is-wrong.png"]]);
    await writeWith(app, teamActor, "SUP-1", "reply", [[JPEG, "the-fix.jpg"]]);
    await writeWith(app, teamActor, "SUP-1", "note", [[GIF, "team-only.gif"]]);
    // Picture ids follow the order they were added: description, reply, note.
    return { ...built, description: 1, reply: 2, note: 3 };
  }

  const fetchStatus = async (app: Express, who: Actor, id: number) =>
    (await as(app, who).get(`/tickets/SUP-1/pictures/${id}`)).status;

  it("is the filer's on the description and the reply, never on the team's note", async () => {
    const { app, description, reply, note } = await threePictures();
    expect(await listed(app, customerOne, "SUP-1")).toEqual([description, reply]);
    expect(await fetchStatus(app, customerOne, description)).toBe(200);
    expect(await fetchStatus(app, customerOne, reply)).toBe(200);
    expect(await fetchStatus(app, customerOne, note)).toBe(404);
  });

  it("is never another customer's, and their refusal is the answer for a missing picture", async () => {
    const { app, description, reply, note } = await threePictures();
    expect(await listed(app, customerTwo, "SUP-1")).toBeNull();
    const missing = await as(app, customerTwo).get("/tickets/SUP-1/pictures/999");
    expect(missing.status).toBe(404);
    for (const id of [description, reply, note]) {
      const refused = await as(app, customerTwo).get(`/tickets/SUP-1/pictures/${id}`);
      expect(refused.status).toBe(404);
      expect(refused.text).toBe(missing.text);
    }
    // The filer's own refusal of the team's note reads like a missing picture too.
    const filerMissing = await as(app, customerOne).get("/tickets/SUP-1/pictures/999");
    const filerRefused = await as(app, customerOne).get(`/tickets/SUP-1/pictures/${note}`);
    expect(filerRefused.status).toBe(404);
    expect(filerRefused.text).toBe(filerMissing.text);
  });

  it("is the team's and the admin's on all three", async () => {
    const { app, description, reply, note } = await threePictures();
    for (const who of [teamActor, adminActor]) {
      expect(await listed(app, who, "SUP-1")).toEqual([description, reply, note]);
      for (const id of [description, reply, note])
        expect(await fetchStatus(app, who, id)).toBe(200);
    }
  });

  it("is listed to an assistant, which can neither load one nor add one", async () => {
    const { app, db, description, reply, note } = await threePictures();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const page = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets", "read_notes", "write_notes"] });
    const key = keyOnPage(page.text);
    await handToAgent(app, "SUP-1", key);
    const asAgent = (path: string) => request(app).get(path).set("Authorization", `Bearer ${key}`);

    const read = await asAgent("/api/tickets/SUP-1");
    const entries = await asAgent("/api/tickets/SUP-1/entries");
    const ids = [
      ...read.body.pictures,
      ...entries.body.flatMap((e: { pictures: unknown[] }) => e.pictures),
    ].map((p: { id: number }) => p.id);
    expect(ids).toEqual([description, reply, note]);
    // The page's address takes no connection key: it sends the caller to sign in.
    const loaded = await asAgent(`/tickets/SUP-1/pictures/${description}`);
    expect(loaded.status).toBe(303);
    expect(loaded.headers["content-type"] ?? "").not.toContain("image");
    // Inside the service, an assistant gets no bytes either: the very connection the ticket was
    // handed to, which may list the ticket's pictures, is refused the picture itself.
    const service = createTicketService(db, "SUP");
    const agent = createConnectionService(db, () => true).authenticate(key)!;
    expect(service.listPictures("SUP-1", agent, null).description).toHaveLength(1);
    expect(() => service.readPicture("SUP-1", description, agent, null)).toThrow(/no picture/);
    // And the API takes no pictures with a note.
    const before = pictureRows(db);
    await request(app)
      .post("/api/tickets/SUP-1/notes")
      .set("Authorization", `Bearer ${key}`)
      .attach("pictures", PNG, "a.png")
      .field("body", "A note");
    expect(pictureRows(db)).toBe(before);
  });
});

describe("a picture as it is served", () => {
  it("carries its checked type and headers that let it do nothing but show", async () => {
    const { app } = buildTestApp();
    // The browser claims it is a web page; the bytes say PNG, and the bytes win.
    await as(app, customerOne)
      .post("/tickets")
      .field("title", ticket.title)
      .field("description", ticket.description)
      .attach("pictures", PNG, { filename: "evil.html", contentType: "text/html" });
    const loaded = await as(app, customerOne).get("/tickets/SUP-1/pictures/1");
    expect(loaded.status).toBe(200);
    expect(loaded.headers["content-type"]).toBe("image/png");
    expect(loaded.headers["x-content-type-options"]).toBe("nosniff");
    expect(loaded.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(loaded.headers["cache-control"]).toBe("private, max-age=3600");
    expect(loaded.headers["content-disposition"]).toBe("inline");
    // A cache never hands one person's picture to another browser.
    expect(loaded.headers.vary).toContain("Cookie");
    expect(JSON.stringify(loaded.headers)).not.toContain("evil");
  });

  it("is allowed on the ticket page from this server only, with nothing else new", async () => {
    const { app } = buildTestApp();
    await fileWith(app, customerOne, [[PNG, "a.png"]]);
    const page = await as(app, customerOne).get("/tickets/SUP-1");
    const policy = String(page.headers["content-security-policy"]);
    expect(policy).toContain("img-src 'self' data:;");
    expect(policy).toContain("default-src 'self';");
  });

  it("answers a malformed picture address like a missing picture", async () => {
    const { app } = buildTestApp();
    await fileWith(app, customerOne, [[PNG, "a.png"]]);
    const missing = await as(app, customerOne).get("/tickets/SUP-1/pictures/999");
    for (const address of ["/tickets/SUP-1/pictures/abc", "/tickets/SUP-0/pictures/1"]) {
      const answer = await as(app, customerOne).get(address);
      expect(answer.status).toBe(404);
      expect(answer.text).toBe(missing.text);
    }
  });
});

describe("the page's data for pictures", () => {
  it("hands each message its pictures, and the description's as ticketPictures", async () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    const upload = { files: [PNG], refused: null };
    service.createTicketWithPictures(ticket, upload, customerOne, null);
    const reply = service.addEntryWithPictures(
      "SUP-1",
      { kind: "reply", body: "Fixed" },
      upload,
      teamActor,
      null,
    );
    const pictures = service.listPictures("SUP-1", customerOne, null);
    expect(pictures.description).toEqual([
      {
        id: 1,
        entry_id: null,
        type: "image/png",
        size: PNG.length,
        created_at: expect.any(String),
        url: "/tickets/SUP-1/pictures/1",
        hidden: null,
      },
    ]);
    expect(pictures.byEntry.get(reply.id)?.map((p) => p.url)).toEqual([
      "/tickets/SUP-1/pictures/2",
    ]);
    expect(service.pictureLimits).toEqual({
      maxBytes: 2 * 1024 * 1024,
      perMessage: 4,
      perTicket: 20,
      personTotalBytes: 40 * 1024 * 1024,
      siteTotalBytes: 300 * 1024 * 1024,
    });
  });
});

describe("the ticket service's own picture limits", () => {
  // The upload parser meets most of these first. The service checks them again, so a caller
  // that skips the parser is held to the same limits.
  const limits: PictureLimits = {
    maxBytes: PNG.length,
    perMessage: 2,
    perTicket: 20,
    personTotalBytes: PNG.length * 3,
    siteTotalBytes: PNG.length * 5,
  };
  const reply = { kind: "reply", body: "Here is what I see." };

  function serviceWith(budgetLimits = limits) {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP", { pictures: budgetLimits });
    service.createTicketWithPictures(ticket, { files: [], refused: null }, customerOne, null);
    return { db, service };
  }

  /** The sentence a refusal of pictures gives, or null when nothing was refused. */
  function refusedWith(add: () => unknown): string | null {
    try {
      add();
      return null;
    } catch (err) {
      if (err instanceof ValidationError) return err.fieldErrors.pictures?.[0] ?? err.message;
      throw err;
    }
  }

  it("refuses a picture over the size limit, and saves nothing", () => {
    const { db, service } = serviceWith();
    const big = Buffer.concat([PNG, Buffer.alloc(1)]);
    const refused = refusedWith(() =>
      service.addEntryWithPictures(
        "SUP-1",
        reply,
        { files: [big], refused: null },
        customerOne,
        null,
      ),
    );
    expect(refused).toBe(PICTURE_REFUSALS.tooLarge(limits));
    expect(pictureRows(db)).toBe(0);
    expect(service.listEntries("SUP-1", customerOne)).toHaveLength(0);
  });

  it("refuses one picture more than a message takes, and saves nothing", () => {
    const { db, service } = serviceWith();
    const refused = refusedWith(() =>
      service.addEntryWithPictures(
        "SUP-1",
        reply,
        { files: [PNG, PNG, PNG], refused: null },
        customerOne,
        null,
      ),
    );
    expect(refused).toBe(PICTURE_REFUSALS.tooManyInMessage(limits));
    expect(pictureRows(db)).toBe(0);
  });

  it("refuses pictures past one person's total, and saves nothing", () => {
    const { db, service } = serviceWith();
    const two = { files: [PNG, PNG], refused: null };
    service.addEntryWithPictures("SUP-1", reply, two, customerOne, null);
    const refused = refusedWith(() =>
      service.addEntryWithPictures("SUP-1", reply, two, customerOne, null),
    );
    expect(refused).toBe(PICTURE_REFUSALS.personFull(limits));
    expect(pictureRows(db)).toBe(2);
    // Someone else still may add theirs.
    service.addEntryWithPictures("SUP-1", reply, two, teamActor, null);
    expect(pictureRows(db)).toBe(4);
  });

  it("refuses pictures past the whole site's total, and saves nothing", () => {
    const { db, service } = serviceWith();
    const two = { files: [PNG, PNG], refused: null };
    service.addEntryWithPictures("SUP-1", reply, two, customerOne, null);
    service.addEntryWithPictures("SUP-1", reply, two, teamActor, null);
    const refused = refusedWith(() =>
      service.addEntryWithPictures("SUP-1", reply, two, adminActor, null),
    );
    expect(refused).toBe(PICTURE_REFUSALS.siteFull(limits));
    expect(pictureRows(db)).toBe(4);
  });

  it("names each total in words", () => {
    expect(PICTURE_REFUSALS.personFull(PICTURE_LIMITS)).toBe(
      "You can add at most 40 MB of pictures in all.",
    );
    expect(PICTURE_REFUSALS.siteFull(PICTURE_LIMITS)).toBe(
      "This site holds at most 300 MB of pictures in all.",
    );
  });
});

describe("deleting a ticket for good", () => {
  it("deletes its pictures with it", async () => {
    const { app, db } = buildTestApp();
    await fileWith(app, customerOne, [[PNG, "a.png"]]);
    await writeWith(app, teamActor, "SUP-1", "note", [[GIF, "b.gif"]]);
    await as(app, customerTwo).post("/api/tickets").send(ticket);
    expect(pictureRows(db)).toBe(2);
    await admin(app).post("/tickets/SUP-1/delete").type("form").send({ confirm: "SUP-1" });
    expect((await admin(app).get("/api/tickets/SUP-1")).status).toBe(410);
    expect(pictureRows(db)).toBe(0);
    expect((await admin(app).get("/tickets/SUP-1/pictures/1")).status).toBe(404);
  });
});

describe("the pictures table", () => {
  it("keeps each picture's bytes as its last column, so listing pictures never reads them", () => {
    const { db } = buildTestApp();
    const columns = db.prepare("PRAGMA table_info(ticket_pictures)").all() as { name: string }[];
    expect(columns.at(-1)?.name).toBe("bytes");
  });
});
