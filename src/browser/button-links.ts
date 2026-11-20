// Some links look and act as buttons, such as "New ticket" and "File a sample ticket", and say so
// with role="button". A real button also works with the Space key, while a link only scrolls the page.
// This script makes Space on such a link follow it, as Enter already does.

/** The parts of a key press this code reads and changes. */
export type KeyPress = {
  key: string;
  repeat: boolean;
  target: unknown;
  preventDefault(): void;
};

/** The parts of a link this code reads and uses. */
export type ButtonLink = {
  tagName: string;
  getAttribute(name: string): string | null;
  click(): void;
};

function isButtonLink(target: unknown): target is ButtonLink {
  if (typeof target !== "object" || target === null) return false;
  const link = target as ButtonLink;
  return link.tagName === "A" && link.getAttribute("role") === "button";
}

/** Follows a button-like link on Space. Returns true when it did. */
export function pressSpace(event: KeyPress): boolean {
  if (event.key !== " " || !isButtonLink(event.target)) return false;
  // Stop the page from scrolling, and follow the link once even if the key is held down.
  event.preventDefault();
  if (!event.repeat) event.target.click();
  return true;
}

if (typeof document !== "undefined") {
  document.addEventListener("keydown", (event) => {
    pressSpace(event);
  });
}
