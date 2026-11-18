// A Copy button beside each command, prompt or key meant to be pasted. Each button carries the
// exact text it copies in data-copy, copies it with the standard clipboard API, and says
// "Copied" for a moment. The buttons are hidden until this runs, so with scripts off nothing
// offers to copy and the text itself stays selectable. Each button is named for what it copies,
// so a screen reader hears what was copied in one status line that exists before any click.

/** The parts of a copy button this code reads and writes. */
export type CopyButton = {
  dataset: { copy?: string };
  hidden: boolean;
  textContent: string | null;
  addEventListener(type: "click", listener: () => void): void;
};

/** Where copied text goes: the browser's clipboard, or a stand-in in tests. */
export type Clipboard = { writeText(text: string): Promise<void> };

/** A line a screen reader announces when its words change. */
export type Status = { textContent: string | null };

export function wireCopyButtons(
  buttons: Iterable<CopyButton>,
  clipboard: Clipboard,
  later: (done: () => void) => void = (done) => setTimeout(done, 1500),
  status?: Status,
) {
  for (const button of buttons) {
    const text = button.dataset.copy;
    if (text === undefined) continue;
    const label = button.textContent;
    button.hidden = false;
    button.addEventListener("click", () => {
      const say = (words: string) => {
        button.textContent = words;
        if (status) status.textContent = words;
        later(() => (button.textContent = label));
      };
      // Without permission to write, the text is still on the page to select by hand.
      clipboard.writeText(text).then(
        () => say("Copied"),
        () => say("Select the text to copy"),
      );
    });
  }
}

if (typeof document !== "undefined" && navigator.clipboard !== undefined) {
  // A real button has all the parts CopyButton names; its event types are only wider.
  const buttons = document.querySelectorAll("button[data-copy]") as unknown as Iterable<CopyButton>;
  // The status line is in the page before any click, so its first message is announced.
  let status: HTMLElement | undefined;
  if (document.querySelector("button[data-copy]") !== null) {
    status = document.createElement("p");
    status.setAttribute("role", "status");
    status.className = "visually-hidden";
    document.body.append(status);
  }
  wireCopyButtons(buttons, navigator.clipboard, undefined, status);
}
