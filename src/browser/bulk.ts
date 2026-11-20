// The ticket list's tick boxes and the bar that changes the ticked tickets. Without this script
// the bar sits above the table, always shown, and every box is ticked by hand; the form posts
// the same either way. With it, the bar lies over the list's filter row, in that row's place and
// height, and shows only while something is ticked, so ticking a row moves nothing on the page.
// While it shows, the filters under it are out of sight and out of reach. It says how many are
// ticked, "Tick every ticket shown" ticks or clears them all, and Clear unticks every row. A bar
// that came back with an error stays where the page put it, above the table with the filter row
// shown, since its message makes it taller than that row; it stays shown until Clear or the last
// untick.

// An element's hidden property, which the browser may also give as "until-found".
type Hideable = { hidden: boolean | string };

/** The parts of a tick box this code reads and changes. */
export type TickBox = Hideable & {
  checked: boolean;
  indeterminate: boolean;
  addEventListener(type: "change", listener: () => void): void;
};

/** The parts of the page this code changes. */
export type BulkParts = {
  /** One box per ticket row. */
  rows: TickBox[];
  /** The boxes that tick every row: one in the header, one above the list on a phone. */
  all: TickBox[];
  /** The bar, and anything else that is hidden until this script runs. */
  bar: Hideable;
  reveal: Hideable[];
  count: { textContent: string | null };
  /** What the bar lies over: hidden from sight, the keyboard and screen readers while it shows. */
  covered: { inert: boolean }[];
  /** The button that unticks every row. */
  clear: { addEventListener(type: "click", listener: () => void): void } | null;
  /** True when the bar came back with an error, so it stays in view. */
  keepOpen: boolean;
};

/** What the bar says for this many ticked tickets. */
export function selectedWords(ticked: number): string {
  return ticked === 0 ? "Change the ticked tickets:" : `${ticked} selected`;
}

/** Wires the boxes to the bar, and returns the function that brings the bar up to date. */
export function wireBulk(parts: BulkParts): () => void {
  const { rows, all, bar, reveal, count, clear, covered } = parts;
  // The error's bar stays open until the person changes the ticks.
  let keepOpen = parts.keepOpen;
  const update = () => {
    const ticked = rows.filter((row) => row.checked).length;
    bar.hidden = ticked === 0 && !keepOpen;
    for (const part of covered) part.inert = !bar.hidden;
    count.textContent = selectedWords(ticked);
    for (const box of all) {
      box.checked = rows.length > 0 && ticked === rows.length;
      box.indeterminate = ticked > 0 && ticked < rows.length;
    }
  };
  for (const row of rows) {
    row.addEventListener("change", () => {
      keepOpen = false;
      update();
    });
  }
  for (const box of all) {
    box.hidden = false;
    box.addEventListener("change", () => {
      for (const row of rows) row.checked = box.checked;
      keepOpen = false;
      update();
    });
  }
  clear?.addEventListener("click", () => {
    for (const row of rows) row.checked = false;
    keepOpen = false;
    update();
  });
  for (const part of reveal) part.hidden = false;
  update();
  return update;
}

if (typeof document !== "undefined") {
  const form = document.querySelector<HTMLFormElement>("form[data-bulk]");
  const bar = form?.querySelector<HTMLElement>("[data-bulk-bar]");
  const count = form?.querySelector<HTMLElement>("[data-bulk-count]");
  if (form && bar && count) {
    const rows = [
      ...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="keys"]'),
    ];
    const clear = bar.querySelector<HTMLButtonElement>("[data-bulk-clear]");
    const dock = document.querySelector<HTMLElement>("[data-bulk-dock]");
    const filters = document.querySelector<HTMLElement>("[data-list-filters]");
    // A refused change: the bar stays in the page's flow, so its message covers nothing.
    const refused = bar.querySelector("[data-bulk-error]") !== null;
    const docked = dock !== null && filters !== null && !refused;
    if (docked) {
      // The dock takes no room and sits where the filter row starts. The bar inside it is at
      // least as tall as the filter row, so it covers the row exactly; it grows down over the
      // list, never pushing it, when it needs more room.
      dock.append(bar);
      const matchRow = () => {
        const height = filters.getBoundingClientRect().height;
        dock.style.setProperty("--bulk-row-height", `${height}px`);
      };
      matchRow();
      new ResizeObserver(matchRow).observe(filters);
      // The page's scroll padding makes room for the bar while it shows, so a row reached with
      // the keyboard is never under it.
      const matchBar = () => {
        const height = bar.getBoundingClientRect().height;
        document.documentElement.style.setProperty("--pd-bulk-bar", `${height}px`);
      };
      new ResizeObserver(matchBar).observe(bar);
    }
    const update = wireBulk({
      rows,
      all: [...form.querySelectorAll<HTMLInputElement>("input[data-bulk-all]")],
      bar,
      reveal: [
        ...form.querySelectorAll<HTMLElement>("[data-bulk-phone]"),
        ...(clear ? [clear] : []),
      ],
      count,
      covered: docked ? [filters] : [],
      clear,
      keepOpen: refused,
    });
    // Clear hides the bar it sits in, so focus goes back to the first row's box.
    clear?.addEventListener("click", () => rows[0]?.focus());
    // Back and Forward can bring the page back with boxes still ticked.
    window.addEventListener("pageshow", update);
  }
}
