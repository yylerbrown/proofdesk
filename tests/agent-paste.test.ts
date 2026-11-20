import { describe, expect, it } from "vitest";
import { agentPaste } from "../src/server/connections/agent-paste.js";

// The one message a person pastes into their AI agent when a key is made.

const address = "https://desk.example";
const key = "pd_12345678_abcdefghijklmnopqrstuvwxyz012345";

describe("the message for an AI agent", () => {
  it("on the real site, names the page for assistants, the key, and to list the handed tickets", () => {
    expect(agentPaste({ address, key, demo: false })).toBe(
      [
        "Please connect to Proofdesk, our support desk.",
        "",
        "1. Read https://desk.example/llms.txt first. It explains the API and the rules.",
        `2. Send this header on every request to https://desk.example/api: Authorization: Bearer ${key}`,
        "3. List the tickets handed to you with GET https://desk.example/api/tickets, and tell me what each one needs. Change nothing yet.",
        '4. If no ticket has been handed to you yet, say so, and tell me how to hand one over: "Open a ticket you own, then More options, Hand to an AI assistant."',
        "5. Your Suggestions setting is Off.",
      ].join("\n"),
    );
  });

  it("with Suggestions When asked, may offer to listen, and still changes nothing yet", () => {
    const message = agentPaste({ address, key, demo: false, suggestions: "when_asked" });
    expect(message).toContain("Change nothing yet.");
    expect(message).toContain(
      "5. Your Suggestions setting is When asked. You can offer to listen for requests to suggest ways to prove a fix, and listen only if I agree.",
    );
    expect(message).not.toContain("without being asked");
  });

  it("with Suggestions Automatic, may suggest on new tickets unasked and changes nothing else", () => {
    const message = agentPaste({ address, key, demo: false, suggestions: "automatic" });
    expect(message).toContain(
      "and tell me what each one needs. You may suggest ways to prove a fix on new tickets without being asked. Change nothing else until I say so.",
    );
    expect(message).not.toContain("Change nothing yet");
    expect(message).toContain("5. Your Suggestions setting is Automatic. You can offer to listen");
  });

  it("on the demo, names the sample ticket and asks for a test spec for its owner to review", () => {
    const message = agentPaste({ address, key, demo: true, sampleKey: "SUP-4" });
    expect(message).toContain("Proofdesk demo");
    expect(message).toContain("GET https://desk.example/api/tickets (there is one, SUP-4).");
    expect(message).toContain(
      "propose a test spec for it, and write a short note asking its owner to review the spec",
    );
    expect(message).not.toContain("Change nothing yet");
  });

  it("on the demo without a recorded sample, still says to list the handed tickets", () => {
    const message = agentPaste({ address, key, demo: true, sampleKey: null });
    expect(message).toContain("GET https://desk.example/api/tickets.");
    expect(message).not.toContain("there is one");
  });
});
