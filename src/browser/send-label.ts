// The team's message box has one button under a choice of who sees the message: "Reply to the
// customer" or "Internal note". Without this script the button reads "Send".
// With it, the button names the audience chosen, "Send reply to customer" or "Save internal
// note", so the last thing a person reads before pressing it says who will read the message.
// The page gives the two labels on the button, as data-label-reply and data-label-note.

/** The parts of the send button this code reads and changes. */
export type SendButton = {
  dataset: { labelReply?: string; labelNote?: string };
  textContent: string | null;
};

/** One of the two choices of who sees the message. */
export type KindChoice = {
  value: string;
  checked: boolean;
  /** The choice the page was sent with. */
  defaultChecked: boolean;
  addEventListener(type: "change", listener: () => void): void;
};

/** The button's words for the kind chosen, or null to leave the button as it is. */
export function labelFor(button: SendButton, kind: string | undefined): string | null {
  if (kind === "reply") return button.dataset.labelReply ?? null;
  if (kind === "note") return button.dataset.labelNote ?? null;
  return null;
}

/**
 * Labels the button for the choice made now, and again each time the choice changes. Returns the
 * function that puts the choice back to the one the page was sent with, and the button with it.
 */
export function wireSendLabel(button: SendButton, choices: KindChoice[]): () => void {
  const update = () => {
    const chosen = choices.find((choice) => choice.checked);
    const label = labelFor(button, chosen?.value);
    if (label !== null) button.textContent = label;
  };
  for (const choice of choices) choice.addEventListener("change", update);
  update();
  return () => {
    for (const choice of choices) choice.checked = choice.defaultChecked;
    update();
  };
}

/**
 * A pageshow listener that runs reset only for a page the browser brought back from its cache,
 * by Back or Forward. A page loaded fresh keeps any choice made while it was still loading.
 */
export function whenBroughtBack(reset: () => void): (event: { persisted: boolean }) => void {
  return (event) => {
    if (event.persisted) reset();
  };
}

if (typeof document !== "undefined") {
  const button = document.querySelector<HTMLButtonElement>("button[data-label-reply]");
  const form = button?.form;
  if (button && form) {
    const choices = [...form.querySelectorAll<HTMLInputElement>("input[type=radio][name=kind]")];
    const backToPage = wireSendLabel(button, choices);
    // A page brought back by Back or Forward keeps the choice made on it, even after an internal
    // note was saved, so the next message could reach no customer. The box starts again on the
    // page's own choice: "Reply to the customer", unless the page means otherwise.
    // A reload needs none of this: the choices ask the browser not to fill them in.
    window.addEventListener("pageshow", whenBroughtBack(backToPage));
  }
}

// The message box is behind one line that looks like a closed text box. Pressing it opens the message
// box, and this script then puts the caret in the box, as pressing a text box would. Without the
// script the box opens and a second press puts the caret in it.
//
// Only a press moves the caret. A box that opens by itself, because a draft or a refused message
// is shown back, leaves focus where the page put it.

/** The parts of the message line, a details element, this code reads. */
export type Fold = {
  open: boolean;
  addEventListener(type: "toggle", listener: () => void): void;
};

/** The parts of the message line's summary this code listens to. */
export type FoldButton = {
  addEventListener(type: "click", listener: () => void): void;
};

/** The message box. */
export type Box = { focus(): void };

/** After a press opens the message line, the caret goes into its box. */
export function focusBoxWhenOpened(fold: Fold, button: FoldButton, box: Box): void {
  let pressed = false;
  // The press comes before the details element opens, so it is still closed here.
  button.addEventListener("click", () => {
    pressed = !fold.open;
  });
  fold.addEventListener("toggle", () => {
    if (fold.open && pressed) box.focus();
    pressed = false;
  });
}

/** The parts of a box this code scrolls to and focuses. */
export type InPlaceBox = {
  focus(options: { preventScroll: boolean }): void;
  scrollIntoView(options: { block: "nearest" }): void;
};

/**
 * The box as a Box that, when focused, scrolls the page only as far as needed to show it, and
 * not at all when it is already in view, so the buttons above it stay under the thumb.
 */
export function inPlace(box: InPlaceBox): Box {
  return {
    focus: () => {
      box.focus({ preventScroll: true });
      box.scrollIntoView({ block: "nearest" });
    },
  };
}

if (typeof document !== "undefined") {
  const fold = document.querySelector<HTMLDetailsElement>("details.reply-fold");
  const button = fold?.querySelector("summary");
  const box = fold?.querySelector("textarea");
  if (fold && button && box) focusBoxWhenOpened(fold, button, box);

  // The customer's "No, it is not fixed" opens its box under both answers in the same way.
  const no = document.querySelector<HTMLDetailsElement>("details.answer-no");
  const noButton = no?.querySelector("summary");
  const noBox = no?.querySelector("textarea");
  if (no && noButton && noBox) focusBoxWhenOpened(no, noButton, inPlace(noBox));
}
