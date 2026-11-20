import { HttpError } from "../errors.js";

// Which assistants are listening for requests for suggestions, kept in this server's memory.
//
// Proofdesk calls no assistant. An assistant that wants to answer people as they ask holds a
// wait_for_requests call open, and Proofdesk answers that call the moment a request arrives.
// Each held call is a bounded resource, counted here like any other: at most a few at once in
// all, and one per connection.

/** The most wait_for_requests calls held open at once, across every connection. */
export const MOST_HELD_CALLS = 4;

/** How long a connection counts as listening after it last called wait_for_requests. */
export const LISTENING_FOR_SECONDS = 40;

/** Why a held call stopped sleeping. */
export type Woken = "woken" | "deadline" | "replaced";

type HeldCall = { replaced: boolean; wake: (why: Woken) => void };

type Listener = {
  /** True when the connection is set to Automatic: it takes the requests a page sends by itself. */
  automatic: boolean;
  /** When it last called wait_for_requests, in milliseconds. */
  lastCallAt: number;
  /** Its call held open now, if any. */
  held: HeldCall | null;
};

export function createListening() {
  const listeners = new Map<number, Listener>();

  function heldCount(): number {
    let count = 0;
    for (const listener of listeners.values()) if (listener.held !== null) count += 1;
    return count;
  }

  return {
    /**
     * Starts one held call for a connection. A second call from the same connection ends its
     * first, which then answers with an empty list, so a client that gave up on a call can
     * always call again. A call past the most held at once is refused, to try again shortly.
     */
    begin(connectionId: number, automatic: boolean) {
      const listener = listeners.get(connectionId);
      if (listener?.held) {
        listener.held.replaced = true;
        listener.held.wake("replaced");
      } else if (heldCount() >= MOST_HELD_CALLS) {
        throw new HttpError(
          429,
          "too_many_requests",
          `Proofdesk already holds ${MOST_HELD_CALLS} wait_for_requests calls, the most it holds at once. Call again in 25 seconds.`,
        );
      }
      const call: HeldCall = { replaced: false, wake: () => {} };
      listeners.set(connectionId, { automatic, lastCallAt: Date.now(), held: call });

      return {
        /** Sleeps until a request may have arrived, the time is up, or a newer call replaced it. */
        sleep(ms: number): Promise<Woken> {
          if (call.replaced) return Promise.resolve("replaced");
          return new Promise((resolve) => {
            const timer = setTimeout(() => resolve("deadline"), ms);
            call.wake = (why) => {
              clearTimeout(timer);
              resolve(why);
            };
          });
        },
        /** Ends the held call. The connection still counts as listening for a while after. */
        end(): void {
          const now = listeners.get(connectionId);
          if (now?.held === call) now.held = null;
        },
      };
    },

    /** Wakes every held call, after a request arrived, so each looks for one it may answer. */
    wakeAll(): void {
      for (const listener of listeners.values()) listener.held?.wake("woken");
    },

    /**
     * The connections listening now: with a call held open, or one made in the last
     * LISTENING_FOR_SECONDS seconds. The others are forgotten.
     */
    listening(): { connectionId: number; automatic: boolean }[] {
      const since = Date.now() - LISTENING_FOR_SECONDS * 1000;
      const found: { connectionId: number; automatic: boolean }[] = [];
      for (const [connectionId, listener] of listeners) {
        if (listener.held !== null || listener.lastCallAt >= since) {
          found.push({ connectionId, automatic: listener.automatic });
        } else {
          listeners.delete(connectionId);
        }
      }
      return found;
    },
  };
}

export type Listening = ReturnType<typeof createListening>;
