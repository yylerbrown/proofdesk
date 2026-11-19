// A link that leads to a closed section further down the page, such as "Add details first
// (optional)" leading to the "Ask with details" form. Without this script the link only scrolls
// to that section's heading, which the person then opens. With it, the section opens as well.
// The link names the section with data-opens, the id of its details element.

/** The parts of a link this code reads. */
export type OpeningLink = {
  dataset: { opens?: string };
  addEventListener(type: "click", listener: () => void): void;
};

/** The parts of a details element this code changes. */
export type Section = { open: boolean };

/** Makes each link open the section it names when it is pressed. */
export function wireOpeningLinks(
  links: Iterable<OpeningLink>,
  find: (id: string) => Section | null,
): void {
  for (const link of links) {
    const id = link.dataset.opens;
    if (id === undefined) continue;
    link.addEventListener("click", () => {
      // The link still follows its address, so the page scrolls to the section it opened.
      const section = find(id);
      if (section !== null) section.open = true;
    });
  }
}

if (typeof document !== "undefined") {
  wireOpeningLinks(document.querySelectorAll<HTMLAnchorElement>("a[data-opens]"), (id) =>
    document.querySelector<HTMLDetailsElement>(`details#${CSS.escape(id)}`),
  );
}
