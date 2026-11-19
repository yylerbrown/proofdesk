import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// The list has five columns: Key, Title, Status, Owner and Filed. Whose turn it is shows only
// when it is not simply the team's, as a few quiet words after the status on the same line.
// The bar for changing ticked tickets offers only the reasons that need no more words.

const valid = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };

function demoApp() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const list = async (id: string, query = "") =>
    parse(
      (await visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`).get(`/tickets${query}`)).text,
    );
  return { list };
}

/** Each row's key and status cell words, in the list's order. */
function statusByKey(page: ReturnType<typeof parse>) {
  return page.querySelectorAll("table.tickets tbody tr").map((row) => {
    const cells = row.querySelectorAll("td");
    return [cells[0]!.text.trim(), cells[2]!.text.trim().replace(/\s+/g, " ")];
  });
}

describe("whose turn it is, in the list", () => {
  it("is a tag after the status only where it is not the team's turn, on the demo's tickets", async () => {
    const { list } = demoApp();
    const team = await list("demo-team");
    const headers = team.querySelectorAll("table.tickets thead th .sort-label");
    expect(headers.map((label) => label.text)).toEqual([
      "Key",
      "Title",
      "Status",
      "Owner",
      "Filed",
    ]);
    const cells = Object.fromEntries(statusByKey(team));
    expect(cells["SUP-7"]).toBe("In Progress Customer said no");
    expect(cells["SUP-2"]).toBe("In Progress Assistant asks for review");
    expect(cells["SUP-3"]).toBe("In Progress");
    expect(cells["SUP-8"]).toBe("New");
    // The customer's confirmation keeps its check mark, and nothing else follows it.
    expect(cells["SUP-6"]).toBe("Resolved ✓");
    // None of the old column's words are left on the page.
    const main = team.querySelector("main")!.text;
    for (const gone of ["Waiting on", "Support team", "Nobody", "Review requested by"]) {
      expect(main).not.toContain(gone);
    }
  });

  it("tells the customer when their answer is needed, and the team that it was asked", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start").expect(200);
    await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({}).expect(200);
    const tag = async (who: typeof teamActor) =>
      parse((await as(app, who).get("/tickets")).text).querySelector("table.tickets .turn-tag")
        ?.text;
    expect(await tag(customerOne)).toBe("Your answer needed");
    expect(await tag(teamActor)).toBe("Asked the customer");
  });

  it("is not a sort, and an old address that asks for one shows the default order", async () => {
    const { list } = demoApp();
    const plain = statusByKey(await list("demo-team"));
    const old = await list("demo-team", "?sort=waiting&direction=asc");
    expect(statusByKey(old)).toEqual(plain);
    expect(old.querySelector("table.tickets th[aria-sort]")).toBeNull();
  });
});

describe("the bar for ticked tickets", () => {
  it("offers the three reasons that need no more words, no text box, and Unassigned", async () => {
    const { list } = demoApp();
    const bar = (await list("demo-team")).querySelector("[data-bulk-bar]")!;
    const options = (name: string) =>
      bar.querySelectorAll(`select[name=${name}] option`).map((option) => option.text);
    expect(options("reason")).toEqual([
      "Reason",
      "Fixed. Not customer-confirmed.",
      "Won't fix",
      "Cannot reproduce",
    ]);
    expect(bar.querySelectorAll("input[type=text], textarea")).toEqual([]);
    expect(options("owner")).toContain("Unassigned");
    expect(options("owner")).not.toContain("Nobody");
  });
});
