// A ticket page left open notices quietly when someone changes the ticket elsewhere. When the
// tab comes back into view, and every 30 seconds while it is in view, it asks the server for a
// cheap reading of the ticket: its version, how many conversation entries this viewer sees, and,
// for the team, how often an assistant was given the ticket or stopped working on it.
// When that differs from what the page shows, one line appears at the top of the ticket with a
// Refresh link. Nothing on the page is replaced, so nothing changes under the person's hands,
// and with scripts off the page simply stays as it was loaded.

/** What the page shows, or what the server says now. */
export type Stamp = { version: number; entries: number; handoffs: number };

/** How the watcher reaches the page, the server and the clock. Tests pass stand-ins. */
export type Watch = {
  /** Asks the server for the ticket's stamp now. Null when it could not be read. */
  read: () => Promise<Stamp | null>;
  /** Shows the line that says the ticket changed. Called once at most. */
  show: () => void;
  /** Whether the tab is in view. */
  visible: () => boolean;
  /** Calls the check every 30 seconds. */
  every: (check: () => void) => void;
  /** Calls the check when the tab comes back into view. */
  onReturn: (check: () => void) => void;
};

export const CHECK_EVERY_MS = 30_000;

/** Whether the ticket changed since the page was drawn. */
export function differs(shown: Stamp, now: Stamp): boolean {
  return (
    shown.version !== now.version ||
    shown.entries !== now.entries ||
    shown.handoffs !== now.handoffs
  );
}

/** Watches one ticket page. Returns the check, so a test can run it by hand. */
export function watchTicket(shown: Stamp, watch: Watch): () => Promise<void> {
  let told = false;
  let asking = false;
  const check = async () => {
    // Once told, the line stays: there is nothing more to say until the person refreshes.
    if (told || asking || !watch.visible()) return;
    asking = true;
    try {
      const now = await watch.read();
      if (now !== null && differs(shown, now)) {
        told = true;
        watch.show();
      }
    } finally {
      asking = false;
    }
  };
  watch.every(() => void check());
  watch.onReturn(() => void check());
  return check;
}

/** The ticket page's own address, for the Refresh link. */
export function ticketAddress(key: string): string {
  return `/tickets/${encodeURIComponent(key)}`;
}

/** Reads a stamp from the server's answer, or null for anything else. */
export function readStamp(value: unknown): Stamp | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, entries, handoffs } = value as {
    version?: unknown;
    entries?: unknown;
    handoffs?: unknown;
  };
  if (typeof version !== "number" || typeof entries !== "number" || typeof handoffs !== "number") {
    return null;
  }
  return { version, entries, handoffs };
}

if (typeof document !== "undefined") {
  const layout = document.querySelector<HTMLElement>("[data-ticket-version]");
  const key = layout?.dataset.ticketKey;
  const version = Number(layout?.dataset.ticketVersion);
  const entries = Number(layout?.dataset.ticketEntries);
  const handoffs = Number(layout?.dataset.ticketHandoffs);
  const counts = [version, entries, handoffs];
  if (layout && key && counts.every((count) => Number.isInteger(count))) {
    watchTicket(
      { version, entries, handoffs },
      {
        read: async () => {
          try {
            const res = await fetch(`/tickets/${encodeURIComponent(key)}/version`, {
              headers: { Accept: "application/json" },
              cache: "no-store",
            });
            return res.ok ? readStamp(await res.json()) : null;
          } catch {
            return null;
          }
        },
        show: () => {
          const line = document.createElement("p");
          line.setAttribute("role", "status");
          line.className = "saved ticket-changed";
          const refresh = document.createElement("a");
          // The ticket's own address: a page drawn after a refused form sits at the form's
          // address, which shows nothing when opened.
          refresh.href = ticketAddress(key);
          refresh.textContent = "Refresh";
          line.append("This ticket changed. ", refresh, " to see it.");
          const heading = document.querySelector("main hgroup");
          if (heading) heading.before(line);
          else layout.before(line);
        },
        visible: () => document.visibilityState === "visible",
        every: (check) => setInterval(check, CHECK_EVERY_MS),
        onReturn: (check) => {
          window.addEventListener("focus", check);
          document.addEventListener("visibilitychange", check);
        },
      },
    );
  }
}
