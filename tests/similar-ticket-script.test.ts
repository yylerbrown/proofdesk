import { describe, expect, it } from "vitest";
import {
  readAnswer,
  showSimilar,
  WAIT_MS,
  wireSimilar,
  worthAsking,
  type Maker,
  type Similar,
  type SimilarLine,
} from "../src/browser/similar-ticket.js";

// The script behind the new ticket form's "Similar ticket" line: when it asks, when it does not,
// how it cancels a question still on its way, and that it builds the line from text only.

/** A made-up element: enough of one for the line and its link. */
type Fake = {
  tag: string;
  attributes: Record<string, string>;
  className: string;
  textContent: string;
  children: (Fake | string)[];
  setAttribute(name: string, value: string): void;
  append(...nodes: (Fake | string)[]): void;
};

function element(tag: string): Fake {
  const made: Fake = {
    tag,
    attributes: {},
    className: "",
    textContent: "",
    children: [],
    setAttribute: (name, value) => {
      made.attributes[name] = value;
    },
    append: (...nodes) => {
      made.children.push(...nodes);
    },
  };
  return made;
}

const make = { createElement: (tag: string) => element(tag) } as unknown as Maker;

function fakeLine() {
  const line = { hidden: true as boolean | string, nodes: [] as (Fake | string)[] };
  const api = {
    get hidden() {
      return line.hidden;
    },
    set hidden(value) {
      line.hidden = value;
    },
    replaceChildren: (...nodes: unknown[]) => {
      line.nodes = nodes as (Fake | string)[];
    },
  };
  return { line, api: api as unknown as SimilarLine };
}

/** The words the line reads as, the link's text and its hidden words included. */
function lineText(nodes: (Fake | string)[]): string {
  return nodes
    .map((node) =>
      typeof node === "string"
        ? node
        : node.textContent + node.children.map((child) => lineText([child])).join(""),
    )
    .join("");
}

/** A clock that runs only when the test says time has passed. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let next = 1;
  return {
    clock: {
      setTimeout: (run: () => void, ms: number) => {
        const id = next++;
        timers.push({ at: now + ms, run, id });
        return id;
      },
      clearTimeout: (id: unknown) => {
        timers = timers.filter((timer) => timer.id !== id);
      },
    },
    pass(ms: number) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.run();
    },
  };
}

const SIGN_IN: Similar = {
  key: "SUP-3",
  title: "Cannot sign in on my phone",
  status: "In Progress",
};

/** The form's Title box, a line, and a server that answers when the test says. */
function form() {
  const listeners: (() => void)[] = [];
  const box = {
    value: "",
    addEventListener: (_type: "input", listener: () => void) => listeners.push(listener),
  };
  const asked: {
    title: string;
    signal: AbortSignal;
    answer(similar: Similar | null): void;
    fail(): void;
  }[] = [];
  const ask = (title: string, signal: AbortSignal) =>
    new Promise<Similar | null>((resolve, reject) => {
      asked.push({ title, signal, answer: resolve, fail: () => reject(new Error("offline")) });
    });
  const { line, api } = fakeLine();
  const time = fakeClock();
  wireSimilar(box, api, ask, make, time.clock);
  const type = (value: string) => {
    box.value = value;
    for (const listener of listeners) listener();
  };
  return { type, asked, line, pass: time.pass };
}

/** Lets the answer's promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("when the form asks", () => {
  it("asks about a title of eight characters or more that holds a space", () => {
    expect(worthAsking("Printer")).toBe(false);
    expect(worthAsking("Printers")).toBe(false);
    expect(worthAsking("Sign in")).toBe(false);
    expect(worthAsking("Sign in!")).toBe(true);
  });

  it("never asks on load, before anything is typed", () => {
    const { asked, line, pass } = form();
    pass(10_000);
    expect(asked).toHaveLength(0);
    expect(line.hidden).toBe(true);
  });

  it("asks once the title rests, not while it is still being typed", () => {
    const { type, asked, pass } = form();
    type("Can't sign in");
    pass(WAIT_MS - 1);
    type("Can't sign in from my phone");
    pass(WAIT_MS - 1);
    expect(asked).toHaveLength(0);
    pass(1);
    expect(asked.map((question) => question.title)).toEqual(["Can't sign in from my phone"]);
  });

  it("does not ask about a short title, and hides the line for one", async () => {
    const { type, asked, line, pass } = form();
    type("Can't sign in from my phone");
    pass(WAIT_MS);
    asked[0]!.answer(SIGN_IN);
    await settle();
    expect(line.hidden).toBe(false);
    type("Can't");
    pass(WAIT_MS);
    expect(asked).toHaveLength(1);
    expect(line.hidden).toBe(true);
  });

  it("never asks twice about the same title", async () => {
    const { type, asked, line, pass } = form();
    type("Can't sign in from my phone");
    pass(WAIT_MS);
    asked[0]!.answer(SIGN_IN);
    await settle();
    type("Can't sign in from my phone now");
    pass(WAIT_MS);
    asked[1]!.answer(null);
    await settle();
    expect(line.hidden).toBe(true);
    type("Can't sign in from my phone");
    pass(WAIT_MS);
    expect(asked).toHaveLength(2);
    expect(line.hidden).toBe(false);
    expect(lineText(line.nodes)).toContain("SUP-3 Cannot sign in on my phone");
  });

  it("cancels a question still on its way when the title changes, and keeps the old line meanwhile", async () => {
    const { type, asked, line, pass } = form();
    type("Can't sign in from my phone");
    pass(WAIT_MS);
    asked[0]!.answer(SIGN_IN);
    await settle();
    type("Can't sign in from my tablet");
    pass(WAIT_MS);
    type("Can't sign in from my tablet today");
    pass(WAIT_MS);
    expect(asked[1]!.signal.aborted).toBe(true);
    expect(asked[2]!.signal.aborted).toBe(false);
    // The old line stays while the new answer is on its way.
    expect(line.hidden).toBe(false);
    // A late answer to the cancelled question changes nothing.
    asked[1]!.answer({ ...SIGN_IN, key: "SUP-9", title: "Tablet sign in" });
    await settle();
    expect(lineText(line.nodes)).toContain("SUP-3");
    asked[2]!.answer(null);
    await settle();
    expect(line.hidden).toBe(true);
  });

  it("hides the line when a question fails", async () => {
    const { type, asked, line, pass } = form();
    type("Can't sign in from my phone");
    pass(WAIT_MS);
    asked[0]!.answer(SIGN_IN);
    await settle();
    type("Can't sign in from my phone now");
    pass(WAIT_MS);
    asked[1]!.fail();
    await settle();
    expect(line.hidden).toBe(true);
  });
});

describe("the line", () => {
  it("reads 'Similar ticket:', then a link to the ticket in a new tab, then its status", () => {
    const { line, api } = fakeLine();
    showSimilar(api, SIGN_IN, make);
    expect(line.hidden).toBe(false);
    expect(lineText(line.nodes)).toBe(
      "Similar ticket: SUP-3 Cannot sign in on my phone (opens in a new tab) (In Progress)",
    );
    const link = line.nodes[1] as Fake;
    expect(link.tag).toBe("a");
    expect(link.attributes).toEqual({ href: "/tickets/SUP-3", target: "_blank", rel: "noopener" });
    expect((link.children[0] as Fake).className).toBe("visually-hidden");
  });

  it("puts a title in as text, never as markup", () => {
    const { line, api } = fakeLine();
    showSimilar(api, { ...SIGN_IN, title: '<img src=x onerror="alert(1)">' }, make);
    const link = line.nodes[1] as Fake;
    expect(link.textContent).toBe('SUP-3 <img src=x onerror="alert(1)">');
    expect(link.children).toHaveLength(1);
  });

  it("reads only an answer in the expected shape", () => {
    expect(readAnswer({ similar: SIGN_IN })).toEqual(SIGN_IN);
    expect(readAnswer({ similar: null })).toBeNull();
    expect(readAnswer({ similar: { key: "SUP-3" } })).toBeNull();
    expect(readAnswer("nothing")).toBeNull();
    expect(readAnswer(null)).toBeNull();
  });
});
