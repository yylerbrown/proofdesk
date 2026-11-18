import { describe, expect, it } from "vitest";
import { startServer } from "../src/server/serve.js";

// The start-up error listener reports a port that cannot be used. Once the server is
// listening, it is removed, so a later server error is never reported as a failed start.

describe("a server that has started", () => {
  it("no longer treats a server error as a failed start", async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    let closed = 0;
    const running = startServer({
      handler: (_req, res) => res.end(),
      port: 0,
      closeDatabase: () => (closed += 1),
      log: (line) => lines.push(line),
      exit: (code) => exits.push(code),
    });
    await running.listening;
    try {
      expect(running.server.listenerCount("error")).toBe(0);
      // With no listener left, the error is thrown as Node throws any unhandled one.
      expect(() => running.server.emit("error", new Error("a later problem"))).toThrow(
        "a later problem",
      );
      expect(lines.join("\n")).not.toContain("could not start");
      expect(exits).toEqual([]);
      expect(closed).toBe(0);
    } finally {
      running.server.close();
    }
  });
});
