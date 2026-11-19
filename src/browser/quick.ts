// Quick answers are plain words on ordinary buttons. Without this script each button sends its
// words as an ordinary answer or reply. With it, pressing one fills the text box it names, so
// the words can be changed before sending; nothing hidden or special is sent.

/** The parts of a quick-answer button this code reads. */
export type QuickButton = {
  dataset: { fill?: string; fillKind?: string };
  value: string;
  addEventListener(type: "click", listener: (event: { preventDefault(): void }) => void): void;
};

/** The text box a quick answer fills. */
export type Field = { value: string; focus(): void };

export function wireQuickAnswers(
  buttons: Iterable<QuickButton>,
  find: (id: string) => Field | null,
  chooseKind: (kind: string) => void = () => undefined,
) {
  for (const button of buttons) {
    const target = button.dataset.fill;
    if (target === undefined) continue;
    button.addEventListener("click", (event) => {
      const field = find(target);
      // Without its box on the page, the button sends its words as it is.
      if (field === null) return;
      event.preventDefault();
      field.value = button.value;
      if (button.dataset.fillKind !== undefined) chooseKind(button.dataset.fillKind);
      field.focus();
    });
  }
}

/** The line above a row of quick buttons. */
export type QuickLabel = { dataset: { filledLabel?: string }; textContent: string | null };

/**
 * Once the buttons fill a box instead of sending, the line above them says so, with the words
 * the page gave it for that. A line without such words is left as it is.
 */
export function relabelQuickAnswers(labels: Iterable<QuickLabel>) {
  for (const label of labels) {
    const words = label.dataset.filledLabel;
    if (words !== undefined) label.textContent = words;
  }
}

if (typeof document !== "undefined") {
  // A real button has all the parts QuickButton names; its event types are only wider.
  const buttons = document.querySelectorAll(
    "button[data-fill]",
  ) as unknown as Iterable<QuickButton>;
  wireQuickAnswers(
    buttons,
    (id) => document.getElementById(id) as HTMLTextAreaElement | null,
    (kind) => {
      for (const radio of document.querySelectorAll<HTMLInputElement>("input[name=kind]")) {
        radio.checked = radio.value === kind;
      }
    },
  );
  // The No answers fill their box only when it is on the page, which is always where they are.
  if (document.getElementById("answer-comment") !== null) {
    relabelQuickAnswers(document.querySelectorAll<HTMLElement>("[data-filled-label]"));
  }
}
