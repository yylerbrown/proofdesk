// The two small menus, "Switch role" in the header and "More" on a ticket, are native details
// elements, so they open and close without any script. This script adds what a menu is expected
// to do from the keyboard: Escape closes it and puts focus back on the button that opened it,
// and moving focus or clicking somewhere else on the page closes it too. More also never opens
// out of sight: with no room under its button it opens upward, or else the page scrolls to it.
//
// The ticket's Resolve panel is a details element too. It holds a form, so it gets only the
// Escape key: moving focus or clicking elsewhere never closes it and hides what was typed.

/** The button that opens a menu: the details element's summary. */
export type MenuButton = { focus(): void };

/** The parts of a details element this code reads and writes. */
export type Menu = {
  open: boolean;
  contains(other: unknown): boolean;
  addEventListener(type: "keydown", listener: (event: { key: string }) => void): void;
  addEventListener(type: "focusout", listener: (event: { relatedTarget: unknown }) => void): void;
  addEventListener(type: "toggle", listener: () => void): void;
};

/** The page around the menus, which hears every click. */
export type Page = {
  addEventListener(type: "click", listener: (event: { target: unknown }) => void): void;
};

/** A menu's list of choices: where it sits, which way it opens, and a way to scroll to it. */
export type MenuList = {
  getBoundingClientRect(): { bottom: number; height: number };
  classList: { toggle(name: string, force: boolean): void };
  scrollIntoView(options: { block: "nearest" }): void;
};

/** How much of the window is free below the bottom edge and above the menu's button. */
export type Room = { windowHeight: number; aboveButton: number };

/** The gap between the button and its list, as site.css draws it. */
const GAP = 6;

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
 * When a menu opens and its list would end below the bottom of the window, it opens upward
 * instead if it fits above its button. If it fits neither way, the page scrolls just enough to
 * show it. A list that fits below opens below, as it always has.
 */
export function keepInView(menu: Menu, list: MenuList, room: () => Room) {
  menu.addEventListener("toggle", () => {
    if (!menu.open) return;
    list.classList.toggle("opens-up", false);
    const box = list.getBoundingClientRect();
    const free = room();
    if (box.bottom <= free.windowHeight) return;
    if (box.height + GAP <= free.aboveButton) {
      list.classList.toggle("opens-up", true);
      return;
    }
    list.scrollIntoView({ block: "nearest" });
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
    const list = menu.querySelector(".more-menu");
    if (list !== null) {
      keepInView(menu as unknown as Menu, list, () => {
        // From tablet width up the header stays at the top of the window and covers the page.
        const header = document.querySelector("body > header");
        const headerBottom = header === null ? 0 : header.getBoundingClientRect().bottom;
        return {
          windowHeight: window.innerHeight,
          aboveButton: button.getBoundingClientRect().top - Math.max(0, headerBottom),
        };
      });
    }
  }
  for (const panel of document.querySelectorAll<HTMLDetailsElement>("details.resolve")) {
    const button = panel.querySelector("summary");
    if (button !== null) closeOnEscape(panel as unknown as Menu, button);
  }
}
