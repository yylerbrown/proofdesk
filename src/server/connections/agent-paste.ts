// The message shown when a connection's key is made: one thing a person pastes into their own
// AI agent. It works for any agent that can make web requests or run commands, with nothing
// else to set up: it names the site's one page for assistants, gives the key and how to send
// it, and says what to do first.

import type { SuggestionChoice } from "./service.js";

/** How a person hands a ticket to an assistant, in the ticket page's own words. */
export const HAND_OVER =
  "Open a ticket, set its Status to In Progress, then More options, Hand to an AI assistant.";

/** The suggestion setting in the words the pages use. */
export const SUGGESTION_WORDS: Record<SuggestionChoice, string> = {
  off: "Off",
  when_asked: "When asked",
  automatic: "Automatic",
};

/** What the message needs to know about the new connection. */
export type AgentPasteInput = {
  /** The site's own address, such as https://desk.example. */
  address: string;
  /** The new key, shown only on the page that made it. */
  key: string;
  /** True for a visitor's demo connection, which works on one sample ticket. */
  demo: boolean;
  /** On the demo, the key of the sample ticket handed to every demo connection. */
  sampleKey?: string | null;
  /** On the real site, the connection's Suggestions setting. Off when it is not given. */
  suggestions?: SuggestionChoice;
};

/** The message to paste into an AI agent, as plain lines of text. */
export function agentPaste(input: AgentPasteInput): string {
  const { address, key } = input;
  const lines = [
    input.demo
      ? "Please connect to the Proofdesk demo, a support desk, and help with one ticket."
      : "Please connect to Proofdesk, our support desk.",
    "",
    `1. Read ${address}/llms.txt first. It explains the API and the rules.`,
    `2. Send this header on every request to ${address}/api: Authorization: Bearer ${key}`,
  ];
  if (input.demo) {
    const which = input.sampleKey ? ` (there is one, ${input.sampleKey})` : "";
    lines.push(
      `3. List the tickets handed to you with GET ${address}/api/tickets${which}.`,
      "4. Read that ticket, propose a test spec for it, and write a short note asking its owner to review the spec. Then stop and tell me what you did.",
    );
    return lines.join("\n");
  }
  const suggestions = input.suggestions ?? "off";
  const list = `3. List the tickets handed to you with GET ${address}/api/tickets, and tell me what each one needs.`;
  if (suggestions === "automatic") {
    lines.push(
      `${list} You may suggest ways to prove a fix on new tickets without being asked. Change nothing else until I say so.`,
    );
  } else {
    lines.push(`${list} Change nothing yet.`);
  }
  lines.push(
    `4. If no ticket has been handed to you yet, say so, and tell me how to hand one over: "${HAND_OVER}"`,
  );
  const setting = `5. Your Suggestions setting is ${SUGGESTION_WORDS[suggestions]}.`;
  if (suggestions === "off") {
    lines.push(setting);
  } else {
    lines.push(
      `${setting} You can offer to listen for requests to suggest ways to prove a fix, and listen only if I agree.`,
    );
  }
  return lines.join("\n");
}
