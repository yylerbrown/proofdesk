import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { browserOf, buildPeopleApp, signedInPerson } from "./people-helpers.js";

// A reopened ticket goes back to its owner only while that owner is still on the team. An owner
// who has left could not even open it, so it goes to New with no owner, and the history says so.

const valid = { title: "Printer is broken", description: "It jams on every page." };

async function setRole(app: Express, cookie: string, person: string, role: string) {
  const res = await browserOf(app, cookie).post("/people").type("form").send({ person, role });
  expect(res.status, res.text).toBe(303);
}

/** A ticket Sam, a team member, resolved; then Sam's role is set to this one. */
async function resolvedBySam(roleAfter: "customer" | "team") {
  const { app, db } = buildPeopleApp();
  const ada = await signedInPerson(db, "1001", "Ada Admin");
  const sam = await signedInPerson(db, "5005", "Sam Helper");
  const di = await signedInPerson(db, "5006", "Di Customer");
  await setRole(app, ada.cookie, sam.id, "team");
  const diBrowser = browserOf(app, di.cookie);
  await diBrowser.post("/api/tickets").send(valid);
  const samBrowser = browserOf(app, sam.cookie);
  await samBrowser.post("/api/tickets/SUP-1/take-and-start");
  const resolved = await samBrowser
    .post("/api/tickets/SUP-1/resolve")
    .send({ reason: "wont_fix", note: "Works as designed." });
  expect(resolved.status).toBe(200);
  if (roleAfter === "customer") await setRole(app, ada.cookie, sam.id, "customer");
  return { app, ada: browserOf(app, ada.cookie), di: diBrowser };
}

describe("reopening a ticket whose owner left the team", () => {
  it("by the customer returns it to New with no owner, and says so in the history", async () => {
    const { ada, di } = await resolvedBySam("customer");
    const res = await di.post("/api/tickets/SUP-1/reopen").send({ reason: "Still jams." });
    expect(res.status).toBe(200);
    expect([res.body.status, res.body.owner_id]).toEqual(["new", null]);
    const events = (await ada.get("/api/tickets/SUP-1/events")).body as {
      type: string;
      data: { from?: string; to?: string | null; owner?: string | null };
    }[];
    const [changed, reopened] = events.slice(-2);
    expect(changed).toMatchObject({
      type: "owner_changed",
      data: { from: "Sam Helper", to: null },
    });
    expect(reopened).toMatchObject({ type: "reopened", data: { to: "new", owner: null } });
  });

  it("by an admin returns it to New with no owner too", async () => {
    const { ada } = await resolvedBySam("customer");
    const res = await ada
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "Resolved by mistake." });
    expect([res.status, res.body.status, res.body.owner_id]).toEqual([200, "new", null]);
  });

  it("keeps an owner who is still on the team, in progress", async () => {
    const { di } = await resolvedBySam("team");
    const res = await di.post("/api/tickets/SUP-1/reopen").send({ reason: "Still jams." });
    expect([res.body.status, res.body.owner_name]).toEqual(["in_progress", "Sam Helper"]);
  });
});
