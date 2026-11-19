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
//
// Just after asking the customer, the message is a line inside the ticket's card, which can sit
// below the first screen on a phone or under a long description. The page then scrolls that
// line to the middle of the window, so the one confirmation is in sight.

/** The parts of an element this code changes. */
export type Focusable = {
  setAttribute(name: string, value: string): void;
  focus(options: { preventScroll: boolean }): void;
  scrollIntoView(options: { block: "center" }): void;
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
  /** True when the message is a line the page must scroll into sight, as it is off the screen. */
  messageOffScreen?: boolean;
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
    if (landing.messageOffScreen === true) landing.message.scrollIntoView({ block: "center" });
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

// The Status menu's Resolved and In Progress choices lead to a small form further down the page,
// with an address that names it, such as #resolve-form, so the browser scrolls it into view. A
// browser does not honour autofocus on a page whose address names a part of it, so the form's
// first box would lose the focus the server gave it. This puts focus back there, where the
// browser has already scrolled.

/** The parts of a box this code focuses. */
export type StartBox = { focus(options: { preventScroll: boolean }): void };

/** Focuses the box the server marked to start on, unless focus is already somewhere. */
export function focusNamedForm(start: StartBox | null, focusTaken: boolean): StartBox | null {
  if (start === null || focusTaken) return null;
  start.focus({ preventScroll: true });
  return start;
}

if (typeof document !== "undefined" && window.location.hash !== "") {
  // The browser moves to the named part once the page has loaded, and that move takes focus
  // away, so the box is focused after it.
  window.addEventListener("load", () => {
    const named = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    const start = named?.matches("form") ? named.querySelector<HTMLElement>("[autofocus]") : null;
    focusNamedForm(
      start ?? null,
      document.activeElement !== null && document.activeElement !== document.body,
    );
  });
}

if (typeof document !== "undefined") {
  const searched = new URLSearchParams(window.location.search).has("q");
  const message = document.querySelector<HTMLElement>(
    [
      'main > p[role="alert"]',
      'main > p[role="status"]',
      'p#sent[role="status"]',
      // Just after asking the customer, the card says so once, in place of its line.
      '.ticket-card p.card-line[role="status"]',
    ].join(", "),
  );
  // Only the card's line can open below the first screen; the others sit at the top of the
  // content or are named by the address, which scrolls to them.
  const box = message?.matches(".ticket-card .card-line") ? message.getBoundingClientRect() : null;
  const messageOffScreen = box !== null && (box.top < 0 || box.bottom > window.innerHeight);
  focusLanding({
    hash: window.location.hash,
    // A box the server marked with autofocus counts even if the browser has not focused it yet.
    focusTaken:
      document.querySelector("[autofocus]") !== null ||
      (document.activeElement !== null && document.activeElement !== document.body),
    message,
    messageId: message?.id,
    messageOffScreen,
    searchBox: searched
      ? document.querySelector<HTMLInputElement>('form[role="search"] input[name="q"]')
      : null,
  });
}
