// Shows each time on the page in the visitor's own time zone and language. The server sends
// every time in UTC, inside <time datetime="...">, and that text stays when scripts are off.
// A time marked data-relative ("3 hours ago") keeps its words and gets the exact time on hover.
// A time marked data-day names a day alone, such as the day on the ticket's card, and shows the
// visitor's own day for it, which near midnight can differ from the day in UTC.

/** The parts of a <time> element this code reads and writes. */
export type TimeElement = {
  dateTime: string;
  title: string;
  textContent: string | null;
  dataset: { relative?: string; day?: string };
};

export function showLocalTimes(
  elements: Iterable<TimeElement>,
  format: Intl.DateTimeFormat,
  dayFormat: Intl.DateTimeFormat,
) {
  for (const element of elements) {
    const when = new Date(element.dateTime);
    if (Number.isNaN(when.getTime())) continue;
    if (element.dataset.relative !== undefined) element.title = format.format(when);
    else if (element.dataset.day !== undefined) element.textContent = dayFormat.format(when);
    else element.textContent = format.format(when);
  }
}

if (typeof document !== "undefined") {
  showLocalTimes(
    document.querySelectorAll<HTMLTimeElement>("time[datetime]"),
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }),
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }),
  );
}
