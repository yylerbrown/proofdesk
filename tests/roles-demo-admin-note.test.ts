import { describe, expect, it } from "vitest";
import { DEMO_ACTORS } from "../src/server/actor.js";
import { adminActor, as, buildTestApp, visitor } from "./helpers.js";

// On the demo the admin is read-only, so the page Who may do what tells them, in one line, what
// the Admin column means. Nobody else sees that line, on the demo or off it.

const DEMO = { DEMO: "on", DEV_SIGN_IN: "off" };
const NOTE = "On this demo the admin only looks.";
const byId = (id: string) => DEMO_ACTORS.find((who) => who.id === id)!;

describe("the demo admin's line on the page Who may do what", () => {
  it("shows for the demo admin", async () => {
    const { app } = buildTestApp(DEMO);
    const answer = await as(app, byId("demo-admin")).get("/roles");
    expect(answer.status).toBe(200);
    expect(answer.text).toContain(NOTE);
  });

  it("does not show for the demo team member, the demo customer or a signed-out visitor", async () => {
    const { app } = buildTestApp(DEMO);
    for (const id of ["demo-team", "demo-customer"]) {
      const answer = await as(app, byId(id)).get("/roles");
      expect(answer.status).toBe(200);
      expect(answer.text, id).not.toContain(NOTE);
    }
    const signedOut = await visitor(app).get("/roles");
    expect(signedOut.text).not.toContain(NOTE);
  });

  it("does not show off the demo, even for an admin", async () => {
    const { app } = buildTestApp();
    const admin = await as(app, adminActor).get("/roles");
    expect(admin.status).toBe(200);
    expect(admin.text).not.toContain(NOTE);
    expect((await visitor(app).get("/roles")).text).not.toContain(NOTE);
  });
});
