// Shows each time on the page in the visitor's own time zone and language. The server sends
// every time in UTC, inside <time datetime="...">, and that text stays when scripts are off.
// A time marked data-relative ("3 hours ago") keeps its words and gets the exact time on hover.

/** The parts of a <time> element this code reads and writes. */
export type TimeElement = {
  dateTime: string;
  title: string;
  textContent: string | null;
  dataset: { relative?: string };
};

export function showLocalTimes(elements: Iterable<TimeElement>, format: Intl.DateTimeFormat) {
  for (const element of elements) {
    const when = new Date(element.dateTime);
    if (Number.isNaN(when.getTime())) continue;
    if (element.dataset.relative === undefined) element.textContent = format.format(when);
    else element.title = format.format(when);
  }
}

if (typeof document !== "undefined") {
  showLocalTimes(
    document.querySelectorAll<HTMLTimeElement>("time[datetime]"),
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }),
  );
}
