// The customer's step after filing: one box for what would prove the ticket is fixed, and, when
// the team's AI assistant suggested some, up to three choices above it.
//
// Picking a choice puts its words in the box. The choice stays picked only while the box still
// holds its words, so an edited box is sent as the customer's own words. Words already typed are
// only ever replaced by a press.
//
// When an assistant is listening, the page may ask it for suggestions: by itself once, when its
// setting is Automatic, or by a quiet button beside the label, when it is When asked. While it
// waits, "Asking the team's AI assistant..." holds the choices' place, and the page reads the
// suggestions once a second, for up to 20 seconds. Focus never moves. With nothing listening the
// page says nothing about an assistant. With scripts off the choices are plain radio buttons
// posted with the form, and nobody is asked.

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
  "Suggested by the team's AI assistant. Pick one to fill the box, then edit it if you like.";

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

/** True when the box still holds a choice's words, compared as the server compares them. */
export function stillMatches(box: string, words: string): boolean {
  const plain = (text: string) => text.trim().replace(/\r\n/g, "\n");
  return plain(box) !== "" && plain(box) === plain(words);
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

/** Keeps a picked choice in step with the box: picking fills it, editing unpicks it. */
export function wireChoices(form: HTMLFormElement, box: HTMLTextAreaElement): void {
  const choices = () => [
    ...form.querySelectorAll<HTMLInputElement>(".proof-choices input[type=radio]"),
  ];
  form.addEventListener("change", (event) => {
    const choice = event.target;
    if (!(choice instanceof HTMLInputElement) || choice.type !== "radio") return;
    if (!choice.checked) return;
    box.value = choice.dataset.words ?? "";
  });
  box.addEventListener("input", () => {
    for (const choice of choices()) {
      if (choice.checked && !stillMatches(box.value, choice.dataset.words ?? "")) {
        choice.checked = false;
      }
    }
  });
}

/** Draws the arrived suggestions in the choices' place. Every word goes in as text. */
function drawChoices(place: HTMLElement, suggestions: Suggestion[]): void {
  const fieldset = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.className = "hint";
  legend.textContent = CHOICES_WORDS;
  fieldset.append(legend);
  for (const suggestion of suggestions) {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "suggestion_id";
    radio.value = String(suggestion.id);
    radio.dataset.words = suggestion.words;
    const words = document.createElement("span");
    words.className = "user-text";
    words.textContent = suggestion.words;
    label.append(radio, " ", words);
    fieldset.append(label);
  }
  // The place keeps the room it held while asking, so the box under it stays where it was.
  place.replaceChildren(fieldset);
  place.hidden = false;
}

/** One grey line in the choices' place, keeping their room. */
function drawLine(place: HTMLElement, words: string): void {
  const line = document.createElement("p");
  line.className = "hint";
  line.textContent = words;
  place.replaceChildren(line);
  place.classList.add("asking");
  place.hidden = false;
}

function wireAsking(form: HTMLFormElement, readUrl: string, askUrl: string): void {
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
    drawLine(place, ASKING_WORDS);
    waitForSuggestions(send(pressed), read, clock, {
      show: (suggestions) => {
        drawChoices(place, suggestions);
        asking = false;
      },
      none: () => {
        drawLine(place, NONE_WORDS);
        window.setTimeout(() => {
          place.replaceChildren();
          place.classList.remove("asking");
          place.hidden = true;
          asking = false;
        }, NONE_SHOWN_MS);
      },
    });
  };
  read().then(
    (answer) => {
      if (answer === null) return;
      const hasChoices = place.querySelector("input[type=radio]") !== null;
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
    wireChoices(form, box);
    const readUrl = form.dataset.proofRead;
    const askUrl = form.dataset.proofAsk;
    if (readUrl && askUrl) wireAsking(form, readUrl, askUrl);
  }
}
