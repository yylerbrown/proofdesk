// The "Add pictures" control on the new ticket form and in the message box. Without this script
// it is the browser's own file picker, and the form sends what was chosen. With it, the chosen
// pictures show as small squares in a strip above the control, each with a remove button named
// for its file, and a picture pasted into the text box or dropped on it is added the same way.
// The picker itself always holds the full list, so the form sends exactly what the strip shows.

/** The picture types the server takes. Anything else pasted or dropped is left alone. */
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The parts of a chosen file this code reads. */
export type Chosen = { name: string; type: string };

/** The control's words: "Add pictures", or "4 of 4 pictures" once the limit is reached. */
export function controlWords(count: number, limit: number): string {
  return count >= limit ? `${limit} of ${limit} pictures` : "Add pictures";
}

/** The name of the button that takes one chosen picture out again. */
export function removeLabel(name: string): string {
  return `Remove ${name}`;
}

/** True for a file the server would take as a picture, going by the type the browser gives it. */
export function isPicture(file: Chosen): boolean {
  return PICTURE_TYPES.includes(file.type);
}

/**
 * The pictures already chosen with the new ones after them, up to the limit. Files that are not
 * pictures, and any past the limit, are left out.
 */
export function addChosen<T extends Chosen>(chosen: T[], incoming: T[], limit: number): T[] {
  const added = incoming.filter(isPicture);
  return [...chosen, ...added].slice(0, Math.max(limit, 0));
}

/** Wires one picker: its strip, its words, and pasting or dropping into its text box. */
function wirePicker(input: HTMLInputElement): void {
  const label = input.closest("label");
  const words = label?.querySelector<HTMLElement>(".add-pictures-words");
  const strip = document.getElementById(input.dataset.picturesStrip ?? "");
  const limit = Number(input.dataset.picturesLimit);
  if (!label || !words || !strip || !Number.isInteger(limit) || limit <= 0) return;
  const named = input.form?.elements.namedItem(input.dataset.picturesBox ?? "");
  const box = named instanceof HTMLTextAreaElement ? named : null;

  label.classList.add("enhanced");
  let chosen: File[] = [];
  let pasted = 0;

  /** Puts the chosen list into the picker, then draws the strip and the words from it. */
  const show = () => {
    const transfer = new DataTransfer();
    for (const file of chosen) transfer.items.add(file);
    input.files = transfer.files;

    const full = chosen.length >= limit;
    words.textContent = controlWords(chosen.length, limit);
    label.classList.toggle("full", full);

    strip.replaceChildren();
    strip.hidden = chosen.length === 0;
    chosen.forEach((file, index) => {
      const item = document.createElement("span");
      item.className = "picture-chosen";
      const image = document.createElement("img");
      image.alt = "";
      image.width = 56;
      image.height = 56;
      // A data address, which the page's content policy already allows for images.
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (typeof reader.result === "string") image.src = reader.result;
      });
      reader.readAsDataURL(file);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "picture-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", removeLabel(file.name));
      remove.addEventListener("click", () => {
        chosen = chosen.filter((_, at) => at !== index);
        show();
        // The next remove button takes focus, or the control once the strip is empty.
        const next = strip.querySelectorAll<HTMLButtonElement>("button.picture-remove");
        (next[Math.min(index, next.length - 1)] ?? input).focus();
      });
      item.append(image, remove);
      strip.append(item);
    });
  };

  const add = (files: File[]) => {
    chosen = addChosen(chosen, files, limit);
    show();
  };

  // The browser's picker replaces its own list on each choice, so the new files join the kept ones.
  input.addEventListener("change", () => add(Array.from(input.files ?? [])));
  // At the limit the control opens nothing.
  input.addEventListener("click", (event) => {
    if (chosen.length >= limit) event.preventDefault();
  });

  if (box !== null) {
    box.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(isPicture);
      if (files.length === 0) return;
      // A picture copied with words keeps its words in the box.
      if (!event.clipboardData?.types.includes("text/plain")) event.preventDefault();
      // A pasted screenshot is always named image.png, so each gets a name of its own.
      add(
        files.map((file) => {
          pasted += 1;
          const ending = file.type.split("/")[1] ?? "png";
          return new File([file], `pasted-picture-${pasted}.${ending}`, { type: file.type });
        }),
      );
    });
    box.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    });
    box.addEventListener("drop", (event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      add(files);
    });
  }

  // A page drawn again, or Back, may already hold files in the picker.
  if (input.files !== null && input.files.length > 0) add(Array.from(input.files));
}

if (typeof document !== "undefined") {
  for (const input of document.querySelectorAll<HTMLInputElement>(
    "input[type=file][data-pictures-limit]",
  )) {
    wirePicker(input);
  }
}
