import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { can } from "../src/server/permissions.js";
import { adminActor, customerOne, teamActor } from "./helpers.js";

/** An assistant's connection issued by an admin: it carries the admin role, but is not a person. */
const adminsAgent: Actor = { ...adminActor, id: "agent-1", kind: "agent" };

describe("the People page's two rules", () => {
  it.each(["list_people", "change_role"] as const)("%s is for an admin person only", (action) => {
    expect(can(adminActor, action)).toBe(true);
    expect(can(teamActor, action)).toBe(false);
    expect(can(customerOne, action)).toBe(false);
    expect(can(adminsAgent, action)).toBe(false);
  });
});
