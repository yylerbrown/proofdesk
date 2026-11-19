import { describe, expect, it } from "vitest";
import {
  differs,
  readStamp,
  ticketAddress,
  watchTicket,
  type Stamp,
  type Watch,
} from "../src/browser/ticket-changed.js";

// The quiet notice on a ticket page left open: it asks for the ticket's stamp when the tab comes
// back into view and on a timer, and shows one line once the ticket has changed. These run the
// script's own logic with stand-ins for the page, the server and the clock.

/** A watcher on stand-ins: the server answers with `answer`, and the tab is in view or not. */
function standIns(answer: () => Stamp | null, inView = () => true) {
  let shown = 0;
  let asked = 0;
  const timers: (() => void)[] = [];
  const returns: (() => void)[] = [];
  const watch: Watch = {
    read: async () => {
      asked++;
      return answer();
    },
    show: () => {
      shown++;
    },
    visible: inView,
    every: (check) => timers.push(check),
    onReturn: (check) => returns.push(check),
  };
  return {
    watch,
    shown: () => shown,
    asked: () => asked,
    timers,
    returns,
  };
}

const page: Stamp = { version: 3, entries: 2, handoffs: 0 };

describe("the ticket-changed notice", () => {
  it("stays quiet while the ticket is as the page shows it", async () => {
    const t = standIns(() => ({ ...page }));
    const check = watchTicket(page, t.watch);
    await check();
    expect(t.asked()).toBe(1);
    expect(t.shown()).toBe(0);
  });

  it("shows its line once when the version, the conversation or an assistant's work changed", async () => {
    for (const now of [
      { version: 4, entries: 2, handoffs: 0 },
      { version: 3, entries: 3, handoffs: 0 },
      { version: 3, entries: 2, handoffs: 1 },
    ]) {
      const t = standIns(() => now);
      const check = watchTicket(page, t.watch);
      await check();
      await check();
      expect(t.shown()).toBe(1);
      // Once told, it stops asking.
      expect(t.asked()).toBe(1);
    }
  });

  it("asks only while the tab is in view, and says nothing when the read fails", async () => {
    let inView = false;
    const hidden = standIns(
      () => ({ version: 9, entries: 9, handoffs: 9 }),
      () => inView,
    );
    const check = watchTicket(page, hidden.watch);
    await check();
    expect(hidden.asked()).toBe(0);
    inView = true;
    const failing = standIns(() => null);
    await watchTicket(page, failing.watch)();
    expect(failing.shown()).toBe(0);
  });

  it("checks on a timer and when the tab comes back", () => {
    const t = standIns(() => ({ ...page }));
    watchTicket(page, t.watch);
    expect(t.timers).toHaveLength(1);
    expect(t.returns).toHaveLength(1);
  });

  it("reads only a well-formed stamp from the server", () => {
    const stamp = { version: 2, entries: 0, handoffs: 0 };
    expect(readStamp(stamp)).toEqual(stamp);
    expect(readStamp({ ...stamp, version: "2" })).toBeNull();
    expect(readStamp({ version: 2, entries: 0 })).toBeNull();
    expect(readStamp(null)).toBeNull();
    expect(differs(page, { version: 3, entries: 2, handoffs: 0 })).toBe(false);
  });

  it("sends Refresh to the ticket's own address, wherever the page was drawn", () => {
    expect(ticketAddress("SUP-2")).toBe("/tickets/SUP-2");
  });
});
