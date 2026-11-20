// The customer's step after filing: one box for what would prove the ticket is fixed, and, when
// the team's AI assistant suggested some, up to three "+" buttons above it.
//
// Pressing a "+" adds its words to the box: alone in an empty box, otherwise on a new line after
// what is there. A button whose words are in the box shows a check and is marked pressed; it goes
// back to "+" when its words are deleted. Words already typed are never replaced.
//
// When an assistant is listening, the page may ask it for suggestions: by itself once, when its
// setting is Automatic, or by a quiet button beside the label, when it is When asked. While it
// waits, "Asking the team's AI assistant..." holds the choices' place, and the page reads the
// suggestions once a second, for up to 20 seconds. Focus never moves. With nothing listening the
// page says nothing about an assistant. With scripts off each "+" posts the form, which comes
// back with the words added and nothing saved, and nobody is asked.

/** One suggested way, as the page's read gives it. */
export type Suggestion = { id: number; words: string };

/** What the page's read says, in the parts this code uses. */
export type ProofRead = {
  suggestions: Suggestion[];
  listening: boolean;
  automatic: boolean;
  /** Where this person's own request stands: none, waiting, answered or expired. */
  request: string;
};

/** How long the page waits for suggestions after asking, in milliseconds. */
export const WAIT_FOR_MS = 20_000;

/** How often the page reads while it waits, in milliseconds. */
export const READ_EVERY_MS = 1_000;

/** How long "No suggestion this time." stays, in milliseconds. */
export const NONE_SHOWN_MS = 4_000;

export const ASKING_WORDS = "Asking the team's AI assistant...";
export const NONE_WORDS = "No suggestion this time.";
export const BUTTON_WORDS = "Suggest ways to prove it";
export const CHOICES_WORDS =
  "Suggested by the team's AI assistant. Press one or more to add them to the box. Edit or remove added text in the box.";

/** The read's answer in the parts this code uses, or null when it is not in the expected shape. */
export function readProof(body: unknown): ProofRead | null {
  if (typeof body !== "object" || body === null) return null;
  const { check_suggestions: list, available, request } = body as Record<string, unknown>;
  if (!Array.isArray(list) || typeof available !== "object" || available === null) return null;
  const suggestions: Suggestion[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { id, words, state } = item as Record<string, unknown>;
    if (typeof id === "number" && typeof words === "string" && state === "offered") {
      suggestions.push({ id, words });
    }
  }
  const { listening, automatic } = available as Record<string, unknown>;
  return {
    suggestions: suggestions.slice(0, 3),
    listening: listening === true,
    automatic: automatic === true,
    request: typeof request === "string" ? request : "none",
  };
}

/**
 * What the page does about asking when the step opens: ask by itself, offer the button, or
 * nothing. A page that already shows choices never asks.
 */
export function askMode(read: ProofRead, hasChoices: boolean): "automatic" | "button" | "none" {
  if (hasChoices || read.suggestions.length > 0) return "none";
  if (read.automatic) return "automatic";
  if (read.listening) return "button";
  return "none";
}

/**
 * After one read while waiting: show the suggestions that arrived, give up, or keep waiting.
 * The page gives up when its request expired or the wait is over.
 */
export function afterRead(read: ProofRead | null, waitedMs: number): "show" | "none" | "wait" {
  if (read !== null && read.suggestions.length > 0) return "show";
  if (read?.request === "expired" || waitedMs >= WAIT_FOR_MS) return "none";
  return "wait";
}

/** Text with plain line breaks and no space at either end, as the server compares the box. */
function plain(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** True when the box holds these words, alone or among other words, as the server decides it. */
export function inBox(box: string, words: string): boolean {
  return plain(words) !== "" && plain(box).includes(plain(words));
}

/**
 * The box after a "+" is pressed: the words alone in an empty box, otherwise on a new line after
 * what is there. Words already in the box are not added again. The server does the same.
 */
export function addToBox(box: string, words: string): string {
  if (plain(words) === "" || inBox(box, words)) return box;
  const before = box.replace(/\s+$/, "");
  return before === "" ? plain(words) : `${before}\n${plain(words)}`;
}

/** The clock this code waits on. Tests pass their own. */
export type Clock = {
  setTimeout(run: () => void, ms: number): unknown;
  now(): number;
};

/**
 * Asks once and waits for suggestions: send the request, then read once a second until they
 * arrive, the request expires or 20 seconds pass. Calls show with the suggestions, or none.
 */
export function waitForSuggestions(
  send: () => Promise<boolean>,
  read: () => Promise<ProofRead | null>,
  clock: Clock,
  done: { show(suggestions: Suggestion[]): void; none(): void },
): void {
  const started = clock.now();
  const next = () => {
    read().then(
      (answer) => step(answer),
      () => step(null),
    );
  };
  const step = (answer: ProofRead | null) => {
    const outcome = afterRead(answer, clock.now() - started);
    if (outcome === "show") done.show(answer!.suggestions);
    else if (outcome === "none") done.none();
    else clock.setTimeout(next, READ_EVERY_MS);
  };
  send().then(
    (accepted) => {
      if (accepted) clock.setTimeout(next, READ_EVERY_MS);
      else done.none();
    },
    () => done.none(),
  );
}

/** Marks each "+" button pressed when its words are in the box now, and not pressed otherwise. */
export function markAdded(form: HTMLFormElement, box: HTMLTextAreaElement): void {
  for (const button of form.querySelectorAll<HTMLButtonElement>("button.proof-add")) {
    button.setAttribute("aria-pressed", String(inBox(box.value, button.value)));
  }
}

/**
 * Wires the "+" buttons to the box: a press adds its words there and nothing is sent, and each
 * button shows whether its words are in the box now.
 */
export function wireAdds(form: HTMLFormElement, box: HTMLTextAreaElement): void {
  const mark = () => markAdded(form, box);
  form.addEventListener("click", (event) => {
    const target = event.target;
    const button = target instanceof Element ? target.closest("button.proof-add") : null;
    if (!(button instanceof HTMLButtonElement)) return;
    event.preventDefault();
    box.value = addToBox(box.value, button.value);
    // As if typed, so whatever listens to the box hears of it.
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  box.addEventListener("input", mark);
  mark();
}

/**
 * Sets the box's height to fit its words, for a browser whose stylesheet cannot. The stylesheet's
 * smallest and largest heights still hold, so the box stays between three and about ten lines.
 */
export function fitBox(box: HTMLTextAreaElement): void {
  const style = getComputedStyle(box);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + borders}px`;
}

/**
 * The suggestions as the script draws them, the same as the page draws them: one grey line,
 * then one "+" button for each. Each one's words are cut to two lines on screen, so three always
 * fit the room kept for them while asking. The full words go in the box when one is pressed,
 * and stay in its name for screen readers and as its tooltip.
 */
function buildChoices(suggestions: Suggestion[]): HTMLElement {
  const group = document.createElement("div");
  const line = document.createElement("p");
  line.className = "hint";
  line.id = "proof-adds-line";
  line.textContent = CHOICES_WORDS;
  const buttons = document.createElement("div");
  buttons.className = "proof-adds";
  for (const suggestion of suggestions) {
    const button = document.createElement("button");
    button.type = "submit";
    button.name = "add";
    button.value = suggestion.words;
    button.className = "proof-add secondary outline";
    button.formNoValidate = true;
    button.title = suggestion.words;
    button.setAttribute("aria-label", `Add: ${suggestion.words}`);
    button.setAttribute("aria-pressed", "false");
    const mark = document.createElement("span");
    mark.className = "proof-add-mark";
    mark.setAttribute("aria-hidden", "true");
    const words = document.createElement("span");
    words.className = "user-text two-lines";
    words.textContent = suggestion.words;
    button.append(mark, words);
    buttons.append(button);
  }
  group.append(line, buttons);
  return group;
}

/** Words long enough to fill two lines at any width, for measuring the room choices take. */
const LONG_WORDS = "Words ".repeat(100);

/**
 * Keeps in the choices' place the room that the legend and three two-line choices take at the
 * page's width now, measured by drawing them unseen for a moment. Choices that arrive never
 * need more, so the box under the place does not move.
 */
function keepRoomForChoices(place: HTMLElement): void {
  const sample = buildChoices([1, 2, 3].map((id) => ({ id, words: LONG_WORDS })));
  sample.style.visibility = "hidden";
  place.style.minHeight = "";
  place.replaceChildren(sample);
  place.hidden = false;
  place.style.minHeight = `${place.getBoundingClientRect().height}px`;
}

/**
 * Draws the arrived suggestions in the choices' place and lets go of the room kept for them, so
 * the box sits as close under them as on a page drawn with them.
 */
function drawChoices(place: HTMLElement, suggestions: Suggestion[]): void {
  place.replaceChildren(buildChoices(suggestions));
  place.style.minHeight = "";
  place.hidden = false;
}

/**
 * "Asking..." with its three dots each in a span, so the stylesheet can step them in a gentle
 * loop. The words read the same with the loop or without it.
 */
function drawAsking(place: HTMLElement): void {
  const line = document.createElement("p");
  line.className = "hint proof-asking";
  line.append(ASKING_WORDS.replace(/\.+$/, ""));
  for (let dot = 0; dot < 3; dot += 1) {
    const span = document.createElement("span");
    span.className = "proof-asking-dot";
    span.textContent = ".";
    line.append(span);
  }
  place.replaceChildren(line);
  place.hidden = false;
}

/** One grey line in the choices' place, in the room kept for the choices. */
function drawLine(place: HTMLElement, words: string): void {
  const line = document.createElement("p");
  line.className = "hint";
  line.textContent = words;
  place.replaceChildren(line);
  place.hidden = false;
}

function wireAsking(
  form: HTMLFormElement,
  box: HTMLTextAreaElement,
  readUrl: string,
  askUrl: string,
): void {
  const place = form.querySelector<HTMLElement>(".proof-choices");
  const labelRow = form.querySelector<HTMLElement>(".proof-label-row");
  if (place === null || labelRow === null) return;
  const read = async (): Promise<ProofRead | null> => {
    const res = await fetch(readUrl, { headers: { Accept: "application/json" } });
    return res.ok ? readProof(await res.json()) : null;
  };
  const send = (pressed: boolean) => async (): Promise<boolean> => {
    const res = await fetch(askUrl, {
      method: "POST",
      body: new URLSearchParams({ pressed: String(pressed) }),
      headers: { Accept: "application/json" },
    });
    return res.ok;
  };
  const clock: Clock = { setTimeout: (run, ms) => window.setTimeout(run, ms), now: Date.now };
  // The button stays where it is and is never disabled, so focus on it stays put. A press
  // while the page waits changes nothing.
  let asking = false;
  const ask = (pressed: boolean) => {
    if (asking) return;
    asking = true;
    keepRoomForChoices(place);
    drawAsking(place);
    waitForSuggestions(send(pressed), read, clock, {
      show: (suggestions) => {
        drawChoices(place, suggestions);
        markAdded(form, box);
        asking = false;
      },
      none: () => {
        drawLine(place, NONE_WORDS);
        window.setTimeout(() => {
          place.replaceChildren();
          place.style.minHeight = "";
          place.hidden = true;
          asking = false;
        }, NONE_SHOWN_MS);
      },
    });
  };
  read().then(
    (answer) => {
      if (answer === null) return;
      const hasChoices = place.querySelector("button.proof-add") !== null;
      const mode = askMode(answer, hasChoices);
      if (mode === "automatic") ask(false);
      if (mode === "button") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "link proof-ask";
        button.textContent = BUTTON_WORDS;
        button.addEventListener("click", () => ask(true));
        labelRow.append(button);
      }
    },
    () => undefined,
  );
}

if (typeof document !== "undefined") {
  const form = document.querySelector<HTMLFormElement>("form.proof-step");
  const box = form?.querySelector<HTMLTextAreaElement>("textarea[name=words]");
  if (form && box) {
    wireAdds(form, box);
    if (!CSS.supports("field-sizing", "content")) {
      box.addEventListener("input", () => fitBox(box));
      fitBox(box);
    }
    const readUrl = form.dataset.proofRead;
    const askUrl = form.dataset.proofAsk;
    if (readUrl && askUrl) wireAsking(form, box, readUrl, askUrl);
  }
}
