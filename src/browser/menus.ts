// The two small menus, "Switch role" in the header and "More" on a ticket, are native details
// elements, so they open and close without any script. This script adds what a menu is expected
// to do from the keyboard: Escape closes it and puts focus back on the button that opened it,
// and moving focus or clicking somewhere else on the page closes it too.

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

export function wireMenu(menu: Menu, button: MenuButton, page: Page) {
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    menu.open = false;
    button.focus();
  });
  menu.addEventListener("focusout", (event) => {
    // Focus moving to nothing, say to another window, is not a reason to close.
    if (event.relatedTarget === null) return;
    if (!menu.contains(event.relatedTarget)) menu.open = false;
  });
  page.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
}

if (typeof document !== "undefined") {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(
    "details.switch-role, details.more",
  )) {
    const button = menu.querySelector("summary");
    if (button === null) continue;
    // A real details element has all the parts Menu names; its event types are only wider.
    wireMenu(menu as unknown as Menu, button, document as unknown as Page);
  }
}
