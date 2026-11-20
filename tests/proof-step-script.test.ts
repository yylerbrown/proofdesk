import { describe, expect, it } from "vitest";
import {
  afterRead,
  askMode,
  readProof,
  stillMatches,
  waitForSuggestions,
  READ_EVERY_MS,
  WAIT_FOR_MS,
  type Clock,
  type ProofRead,
  type Suggestion,
} from "../src/browser/proof-step.js";

// The step's script: it reads the page's read of the suggestions, decides whether to ask a
// listening assistant, waits for an answer for up to 20 seconds, and keeps a picked choice in
// step with the box.

const quiet: ProofRead = { suggestions: [], listening: false, automatic: false, request: "none" };

describe("reading the page's read", () => {
  it("keeps only offered suggestions, at most three, with their words as text", () => {
    const read = readProof({
      check_suggestions: [
        { id: 1, words: "<b>one</b>", state: "offered" },
        { id: 2, words: "two", state: "withdrawn" },
        { id: 3, words: "three", state: "offered" },
        { id: 4, words: "four", state: "offered" },
        { id: 5, words: "five", state: "offered" },
      ],
      available: { listening: true, automatic: false },
      request: "waiting",
    });
    expect(read).toEqual({
      suggestions: [
        { id: 1, words: "<b>one</b>" },
        { id: 3, words: "three" },
        { id: 4, words: "four" },
      ],
      listening: true,
      automatic: false,
      request: "waiting",
    });
  });

  it("answers null for anything not in the expected shape", () => {
    expect(readProof(null)).toBeNull();
    expect(readProof({ check_suggestions: "no" })).toBeNull();
    expect(readProof({ check_suggestions: [] })).toBeNull();
  });
});

describe("whether to ask", () => {
  it("asks by itself for Automatic, offers the button for When asked, and else nothing", () => {
    expect(askMode({ ...quiet, listening: true, automatic: true }, false)).toBe("automatic");
    expect(askMode({ ...quiet, listening: true }, false)).toBe("button");
    expect(askMode(quiet, false)).toBe("none");
  });

  it("never asks when choices are already there", () => {
    const listening = { ...quiet, listening: true, automatic: true };
    expect(askMode(listening, true)).toBe("none");
    expect(askMode({ ...listening, suggestions: [{ id: 1, words: "x" }] }, false)).toBe("none");
  });
});

describe("after each read while waiting", () => {
  it("shows what arrived, gives up when the request expired or 20 seconds passed", () => {
    const arrived = { ...quiet, suggestions: [{ id: 1, words: "x" }] };
    expect(afterRead(arrived, 500)).toBe("show");
    expect(afterRead({ ...quiet, request: "expired" }, 500)).toBe("none");
    expect(afterRead({ ...quiet, request: "waiting" }, WAIT_FOR_MS)).toBe("none");
    expect(afterRead({ ...quiet, request: "waiting" }, WAIT_FOR_MS - 1)).toBe("wait");
    expect(afterRead(null, 500)).toBe("wait");
  });
});

describe("a picked choice and the box", () => {
  it("stay together only while the box holds the choice's words", () => {
    expect(stillMatches("Every row", "Every row")).toBe(true);
    expect(stillMatches("  Every row\r\n", "Every row")).toBe(true);
    expect(stillMatches("Every row, in order", "Every row")).toBe(false);
    expect(stillMatches("", "")).toBe(false);
  });
});

/** A clock that runs each timer at once and moves time on by its delay. */
function fastClock(): Clock & { at: number } {
  const clock = {
    at: 0,
    now: () => clock.at,
    setTimeout(run: () => void, ms: number) {
      clock.at += ms;
      queueMicrotask(run);
      return 0;
    },
  };
  return clock;
}

function outcome() {
  let resolve: (value: Suggestion[] | "none") => void = () => {};
  const done = new Promise<Suggestion[] | "none">((r) => (resolve = r));
  return {
    done,
    handlers: { show: (s: Suggestion[]) => resolve(s), none: () => resolve("none") },
  };
}

describe("waiting for suggestions", () => {
  it("reads once a second after asking, and shows them when they arrive", async () => {
    const clock = fastClock();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return reads < 3
        ? { ...quiet, request: "waiting" }
        : { ...quiet, suggestions: [{ id: 7, words: "Every row" }] };
    };
    const { done, handlers } = outcome();
    waitForSuggestions(async () => true, read, clock, handlers);
    expect(await done).toEqual([{ id: 7, words: "Every row" }]);
    expect(reads).toBe(3);
    expect(clock.at).toBe(3 * READ_EVERY_MS);
  });

  it("gives up after 20 seconds of nothing", async () => {
    const clock = fastClock();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return { ...quiet, request: "waiting" };
    };
    const { done, handlers } = outcome();
    waitForSuggestions(async () => true, read, clock, handlers);
    expect(await done).toBe("none");
    expect(reads).toBe(WAIT_FOR_MS / READ_EVERY_MS);
  });

  it("gives up at once when the request is refused, without reading", async () => {
    let reads = 0;
    const { done, handlers } = outcome();
    waitForSuggestions(
      async () => false,
      async () => {
        reads += 1;
        return quiet;
      },
      fastClock(),
      handlers,
    );
    expect(await done).toBe("none");
    expect(reads).toBe(0);
  });
});
