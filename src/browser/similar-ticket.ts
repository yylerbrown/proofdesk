// On the new ticket form, once the person types a title and pauses, one quiet line under the
// Title box names an earlier ticket whose title is like it: "Similar ticket: SUP-3 Cannot sign
// in on my phone (In Progress)". The line links to that ticket in a new tab, so the half-written
// form is kept. Nothing shows on page load, nothing shows when no ticket is alike, and filing is
// never held up. With scripts off the form is exactly as it was.

/** An earlier ticket the server names. */
export type Similar = { key: string; title: string; status: string };

/** Asks the server about one title. Throws when the question fails. */
export type Ask = (title: string, signal: AbortSignal) => Promise<Similar | null>;

/** The parts of the Title box this code reads. */
export type TitleBox = {
  value: string;
  addEventListener(type: "input", listener: () => void): void;
};

/** The line under the Title box. */
export type SimilarLine = {
  hidden: boolean | string;
  replaceChildren(...nodes: (Node | string)[]): void;
};

/** What the line is built from: the page's own document. */
export type Maker = { createElement(tag: "a" | "span"): HTMLElement };

/** How long the title must rest, in milliseconds, before the server is asked. */
export const WAIT_MS = 300;

/** The server's address for the question. */
export const SIMILAR_URL = "/tickets/similar";

/**
 * True when a title is worth asking about: eight characters or more, holding a space, so a
 * first word on its own is never sent.
 */
export function worthAsking(title: string): boolean {
  return title.length >= 8 && title.includes(" ");
}

/** The ticket in the server's answer, or null when it names none or is not in the expected shape. */
export function readAnswer(body: unknown): Similar | null {
  if (typeof body !== "object" || body === null) return null;
  const similar = (body as { similar?: unknown }).similar;
  if (typeof similar !== "object" || similar === null) return null;
  const { key, title, status } = similar as Record<string, unknown>;
  if (typeof key !== "string" || typeof title !== "string" || typeof status !== "string") {
    return null;
  }
  return { key, title, status };
}

/**
 * Fills the line for one ticket, or hides it for none. Every word goes in as text, never as
 * markup, so a title can never add anything to the page.
 */
export function showSimilar(line: SimilarLine, similar: Similar | null, make: Maker): void {
  if (similar === null) {
    line.hidden = true;
    line.replaceChildren();
    return;
  }
  const link = make.createElement("a");
  link.setAttribute("href", `/tickets/${encodeURIComponent(similar.key)}`);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener");
  link.textContent = `${similar.key} ${similar.title}`;
  const newTab = make.createElement("span");
  newTab.className = "visually-hidden";
  newTab.textContent = " (opens in a new tab)";
  link.append(newTab);
  // The words before and the status after are their own pieces, so only the title shortens.
  // Their spaces stay in the text for copying and screen readers; the line draws the gaps. The
  // space before the status does not break, so the status never sits alone on a line.
  const before = make.createElement("span");
  before.textContent = "Similar ticket: ";
  const status = make.createElement("span");
  status.textContent = `\u00a0(${similar.status})`;
  line.replaceChildren(before, link, status);
  line.hidden = false;
}

/** The clock this code waits on. Tests pass their own. */
export type Clock = {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

/**
 * Asks about the title each time it rests for WAIT_MS. A title is asked about once: its answer
 * is kept for the rest of the visit. A new question cancels the one still on its way. While an
 * answer is on its way the old line stays, so it does not flicker. A failed question hides the
 * line.
 */
export function wireSimilar(
  box: TitleBox,
  line: SimilarLine,
  ask: Ask,
  make: Maker,
  clock: Clock,
): void {
  const answers = new Map<string, Similar | null>();
  let timer: unknown = null;
  let asking: AbortController | null = null;

  const check = () => {
    const title = box.value.trim();
    asking?.abort();
    asking = null;
    if (!worthAsking(title)) {
      showSimilar(line, null, make);
      return;
    }
    if (answers.has(title)) {
      showSimilar(line, answers.get(title)!, make);
      return;
    }
    const controller = new AbortController();
    asking = controller;
    ask(title, controller.signal).then(
      (similar) => {
        if (controller.signal.aborted) return;
        answers.set(title, similar);
        showSimilar(line, similar, make);
      },
      () => {
        if (controller.signal.aborted) return;
        showSimilar(line, null, make);
      },
    );
  };

  box.addEventListener("input", () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(check, WAIT_MS);
  });
}

/** Asks this site's server. The title goes in the body, never in the address. */
export async function askServer(title: string, signal: AbortSignal): Promise<Similar | null> {
  const res = await fetch(SIMILAR_URL, {
    method: "POST",
    body: new URLSearchParams({ title }),
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return readAnswer(await res.json());
}

if (typeof document !== "undefined") {
  // Only the new ticket form's Title box carries this, so the edit form never asks.
  const box = document.querySelector<HTMLInputElement>("input[data-similar-into]");
  const line = box && document.getElementById(box.dataset.similarInto ?? "");
  if (box && line) {
    wireSimilar(box, line, askServer, document, {
      setTimeout: (run, ms) => window.setTimeout(run, ms),
      clearTimeout: (timer) => window.clearTimeout(timer as number),
    });
  }
}
