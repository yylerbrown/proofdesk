// A link that leads to a closed section further down the page, such as "Add details first
// (optional)" leading to the "Ask with details" form inside "More options". Without this script
// the link only scrolls to that section, which the person then opens. With it, the section opens
// as well, and so does every closed section around it. The link names the section with
// data-opens, the id of its details element.

/** The parts of a link this code reads. */
export type OpeningLink = {
  dataset: { opens?: string };
  addEventListener(type: "click", listener: () => void): void;
};

/** The parts of a details element this code changes. */
export type Section = { open: boolean };

/**
 * Makes each link open the section it names when it is pressed. For an id, find gives that
 * section and the sections it sits inside, or nothing when it is not on the page.
 */
export function wireOpeningLinks(
  links: Iterable<OpeningLink>,
  find: (id: string) => Section[],
): void {
  for (const link of links) {
    const id = link.dataset.opens;
    if (id === undefined) continue;
    link.addEventListener("click", () => {
      // The link still follows its address, so the page scrolls to the section it opened.
      for (const section of find(id)) section.open = true;
    });
  }
}

/** The details element with this id and every details element around it. */
function sectionAndParents(id: string): HTMLDetailsElement[] {
  const sections: HTMLDetailsElement[] = [];
  let section = document.querySelector<HTMLDetailsElement>(`details#${CSS.escape(id)}`);
  while (section !== null) {
    sections.push(section);
    section = section.parentElement?.closest<HTMLDetailsElement>("details") ?? null;
  }
  return sections;
}

if (typeof document !== "undefined") {
  wireOpeningLinks(
    document.querySelectorAll<HTMLAnchorElement>("a[data-opens]"),
    sectionAndParents,
  );
}
