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
  addEventListener(type: "change", listener: () => void): void;
};

/** The button's words for the kind chosen, or null to leave the button as it is. */
export function labelFor(button: SendButton, kind: string | undefined): string | null {
  if (kind === "reply") return button.dataset.labelReply ?? null;
  if (kind === "note") return button.dataset.labelNote ?? null;
  return null;
}

/** Labels the button for the choice made now, and again each time the choice changes. */
export function wireSendLabel(button: SendButton, choices: KindChoice[]): void {
  const update = () => {
    const chosen = choices.find((choice) => choice.checked);
    const label = labelFor(button, chosen?.value);
    if (label !== null) button.textContent = label;
  };
  for (const choice of choices) choice.addEventListener("change", update);
  update();
}

if (typeof document !== "undefined") {
  const button = document.querySelector<HTMLButtonElement>("button[data-label-reply]");
  const form = button?.form;
  if (button && form) {
    const choices = [...form.querySelectorAll<HTMLInputElement>("input[type=radio][name=kind]")];
    wireSendLabel(button, choices);
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

if (typeof document !== "undefined") {
  const fold = document.querySelector<HTMLDetailsElement>("details.reply-fold");
  const button = fold?.querySelector("summary");
  const box = fold?.querySelector("textarea");
  if (fold && button && box) focusBoxWhenOpened(fold, button, box);
}
