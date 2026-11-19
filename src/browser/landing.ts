// Where keyboard focus starts when a page opens just after an action.
//
// After a save or a refusal the page opens with one line at the top of the content, such as
// "You own this ticket, and it is in progress." This script moves focus to that line, so a
// screen reader reads it and the next Tab goes on from there, not from the top of the page.
// After a search, focus goes back to the search box instead, with the cursor after the words
// already there, so the next typing adds to them in every browser.
//
// Focus is left alone when the address names a part of the page, such as #conversation, or
// when the page has already put focus on a box with something to fix. The one part of the page
// that still gets focus is the message line itself: after a reply or a note the address names
// that line, #sent, which sits under the conversation by the message box.

/** The parts of an element this code changes. */
export type Focusable = {
  setAttribute(name: string, value: string): void;
  focus(options: { preventScroll: boolean }): void;
};

/** The search box: it takes focus, and its cursor can be moved. */
export type SearchBox = Focusable & {
  value: string;
  setSelectionRange(start: number, end: number): void;
};

/** What this code reads from the page as it opens. */
export type Landing = {
  /** The part of the address after #, empty when there is none. */
  hash: string;
  /** True when focus is already on something other than the page itself. */
  focusTaken: boolean;
  /** The saved or refused line at the top of the content, or the sent line, if there is one. */
  message: Focusable | null;
  /** The message line's id, when it has one, so an address that names it still focuses it. */
  messageId?: string;
  /** The list's search box when the address holds a search, otherwise null. */
  searchBox: SearchBox | null;
};

/** Moves focus to where the page should start. Returns what it focused, or null. */
export function focusLanding(landing: Landing): Focusable | null {
  const namesMessage = landing.message !== null && landing.hash === `#${landing.messageId}`;
  if ((landing.hash !== "" && !namesMessage) || landing.focusTaken) return null;
  if (landing.message !== null) {
    // A paragraph takes focus only with a tabindex; -1 keeps it out of the Tab order.
    landing.message.setAttribute("tabindex", "-1");
    landing.message.focus({ preventScroll: true });
    return landing.message;
  }
  if (landing.searchBox !== null) {
    landing.searchBox.focus({ preventScroll: true });
    // Without this, one browser puts the cursor before the old words and another selects them.
    const end = landing.searchBox.value.length;
    landing.searchBox.setSelectionRange(end, end);
    return landing.searchBox;
  }
  return null;
}

if (typeof document !== "undefined") {
  const searched = new URLSearchParams(window.location.search).has("q");
  const message = document.querySelector<HTMLElement>(
    'main > p[role="alert"], main > p[role="status"], p#sent[role="status"]',
  );
  focusLanding({
    hash: window.location.hash,
    // A box the server marked with autofocus counts even if the browser has not focused it yet.
    focusTaken:
      document.querySelector("[autofocus]") !== null ||
      (document.activeElement !== null && document.activeElement !== document.body),
    message,
    messageId: message?.id,
    searchBox: searched
      ? document.querySelector<HTMLInputElement>('form[role="search"] input[name="q"]')
      : null,
  });
}
