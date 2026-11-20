// The person menu in the header, named for whoever is signed in, is a native details element, so
// it opens and closes without any script. This script adds what a menu is expected to do from the keyboard:
// Escape closes it and puts focus back on the button that opened it, and moving focus or
// clicking somewhere else on the page closes it too.
//
// The ticket page's Status and Owner menus are details elements too, and behave the same way.
// Once a menu is open, the Up and Down arrow keys move focus between its choices.

/** The button that opens a menu: the details element's summary. */
export type MenuButton = { focus(): void };

/** The parts of a details element this code reads and writes. */
export type Menu = {
  open: boolean;
  contains(other: unknown): boolean;
  addEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
  addEventListener(type: "focusout", listener: (event: { relatedTarget: unknown }) => void): void;
};

/** The page around the menus, which hears every click. */
export type Page = {
  addEventListener(type: "click", listener: (event: { target: unknown }) => void): void;
};

/** Escape closes an open details element and puts focus back on its button. */
export function closeOnEscape(menu: Menu, button: MenuButton) {
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    menu.open = false;
    button.focus();
  });
}

export function wireMenu(menu: Menu, button: MenuButton, page: Page) {
  closeOnEscape(menu, button);
  menu.addEventListener("focusout", (event) => {
    // Focus moving to nothing, say to another window, is not a reason to close.
    if (event.relatedTarget === null) return;
    if (!menu.contains(event.relatedTarget)) menu.open = false;
  });
  page.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
}

/**
 * Which choice the Up or Down arrow moves focus to, by its place in the list: the next or the
 * one before, wrapping round at either end. From the menu's own button, or anything that is not
 * a choice (current is -1), Down goes to the first choice and Up to the last. Null for any other
 * key, or when the menu has no choices.
 */
export function arrowTarget(count: number, current: number, key: string): number | null {
  if (count === 0) return null;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp") return current < 0 ? count - 1 : (current - 1 + count) % count;
  return null;
}

/** The choices in an open menu that the arrow keys move between: its links and live buttons. */
function choicesIn(menu: HTMLDetailsElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>("ul a[href], ul button:not([disabled])")];
}

/** Up and Down move focus between an open menu's choices; a select keeps its own arrows. */
function moveWithArrows(menu: HTMLDetailsElement) {
  menu.addEventListener("keydown", (event) => {
    if (!menu.open || event.target instanceof HTMLSelectElement) return;
    const choices = choicesIn(menu);
    const current = choices.indexOf(document.activeElement as HTMLElement);
    const target = arrowTarget(choices.length, current, event.key);
    if (target === null) return;
    // The arrow would otherwise scroll the page.
    event.preventDefault();
    choices[target]!.focus();
  });
}

if (typeof document !== "undefined") {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(
    "details.person-menu, details.fact-menu",
  )) {
    const button = menu.querySelector("summary");
    if (button === null) continue;
    // A real details element has all the parts Menu names; its event types are only wider.
    wireMenu(menu as unknown as Menu, button, document as unknown as Page);
    moveWithArrows(menu);
  }
}
