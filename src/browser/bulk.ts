// The ticket list's tick boxes and the bar that changes the ticked tickets. Without this script
// the bar is always shown and every box is ticked by hand; the form posts the same either way.
// With it, the bar shows only while something is ticked and says how many are, and "Tick every
// ticket shown" ticks or clears them all. A bar that came back with an error stays shown.

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
  /** True when the bar came back with an error, so it stays in view. */
  keepOpen: boolean;
};

/** What the bar says for this many ticked tickets. */
export function selectedWords(ticked: number): string {
  return ticked === 0 ? "Change the ticked tickets:" : `${ticked} selected`;
}

/** Wires the boxes to the bar, and returns the function that brings the bar up to date. */
export function wireBulk(parts: BulkParts): () => void {
  const { rows, all, bar, reveal, count, keepOpen } = parts;
  const update = () => {
    const ticked = rows.filter((row) => row.checked).length;
    bar.hidden = ticked === 0 && !keepOpen;
    count.textContent = selectedWords(ticked);
    for (const box of all) {
      box.checked = rows.length > 0 && ticked === rows.length;
      box.indeterminate = ticked > 0 && ticked < rows.length;
    }
  };
  for (const row of rows) row.addEventListener("change", update);
  for (const box of all) {
    box.hidden = false;
    box.addEventListener("change", () => {
      for (const row of rows) row.checked = box.checked;
      update();
    });
  }
  for (const part of reveal) part.hidden = false;
  update();
  return update;
}

if (typeof document !== "undefined") {
  const form = document.querySelector<HTMLFormElement>("form[data-bulk]");
  const bar = form?.querySelector<HTMLElement>("[data-bulk-bar]");
  const count = form?.querySelector<HTMLElement>("[data-bulk-count]");
  if (form && bar && count) {
    const update = wireBulk({
      rows: [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="keys"]')],
      all: [...form.querySelectorAll<HTMLInputElement>("input[data-bulk-all]")],
      bar,
      reveal: [...form.querySelectorAll<HTMLElement>("[data-bulk-phone]")],
      count,
      keepOpen: bar.querySelector("[data-bulk-error]") !== null,
    });
    // Back and Forward can bring the page back with boxes still ticked.
    window.addEventListener("pageshow", update);
  }
}
