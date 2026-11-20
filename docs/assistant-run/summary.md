# One assistant run against the Proofdesk demo (second run)

**When:** 18 Nov 2026, 14:29:25 to 14:30:21 UTC.
**Product:** https://support-desk-demo.fly.dev, commit e972938, seeded 14:20 UTC.
**Assistant:** Claude Code 2.1.319, headless, model alias `opus` (reported as `claude-opus-5-5`).
**Outcome:** the whole path. It found SUP-4 ("Sample for your AI assistant: the total adds tax twice"), reproduced the bug and tested a fix with Node in its scratch folder, proposed a one-scenario test spec, attached the test run as evidence naming that scenario, and asked the owner to review. Everything it told Proofdesk matches a result in the transcript. 15 turns, 55 seconds, US$0.28 at list price.

## Setup steps before the run
1. As a visitor: "Get a demo connection" on the welcome page. Key into a private file, never printed. Connection "Demo visitor ea29379c". Scopes: read tickets (without internal notes), write notes, attach evidence, propose specs.
2. Nothing else. SUP-4 was already owned by Demo Team Member and In Progress from the seed, and handed to every demo connection; the connection's `list_tickets` returned SUP-4 alone.

## How it was run
From a new empty folder with a clean environment (HOME, PATH, USER, LANG and the key only), the key read from a private file into `PROOFDESK_KEY`, this exact command:

```sh
claude -p --model opus --setting-sources project --no-session-persistence \
  --mcp-config mcp-config.json --strict-mcp-config \
  --settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":false,"allowUnsandboxedCommands":false},"permissions":{"deny":["Read(~/**)"]}}' \
  --allowedTools "mcp__proofdesk" "Write(./**)" "Edit(./**)" "Read(./**)" "Bash(node *)" \
  --output-format stream-json --verbose \
  "Using Proofdesk, find the ticket that is ready for an assistant, read what the customer needs, actually do the check it describes as far as you can from here, attach what you found as evidence, propose a short test spec, and ask the owner to review. Do not claim anything you did not observe." \
  < /dev/null
```
- File tools limited to the folder; only `node` commands allowed.
- Claude Code's own sandbox switched on: no writes outside the folder, home folder unreadable, no network. Probes confirmed `curl`, `rm` and compound commands were refused.
- The opening event shows one server and the nine Proofdesk tools the connection's scopes allow. One run, no coaching, no edits, no reruns.

## The prompt
> Using Proofdesk, find the ticket that is ready for an assistant, read what the customer needs, actually do the check it describes as far as you can from here, attach what you found as evidence, propose a short test spec, and ask the owner to review. Do not claim anything you did not observe.

## Calls and results
1. `list_tickets`: one short row, SUP-4, with the customer's check.
2. `get_ticket SUP-4`: check "total(100, 0.1) returns 110, and a test shows it"; owner Demo Team Member; no spec; `ready_token: null`.
3. Wrote `sup4/total.js` (the ticket's function kept as `totalOriginal`, the fix as `total`) and `sup4/total.test.js` (three node:test cases). Two shell attempts were refused for syntax; it switched to the file tools.
4. `node --test sup4/total.test.js`: 3 passed, 0 failed on Node v25.2.1. The original returns 120, the fix returns 110, and the fix returns 100 with no tax.
5. `propose_spec`: one scenario, "Tax is applied once". Came back proposed, `verified_by_proofdesk: false`.
6. `add_evidence`: kind test, naming scenario 1, the command, the result, revision "local scratch copy, not the product repo", and a JSON report including what it did not verify. `verified_by_proofdesk: false`.
7. `ask_owner_to_review`: what it observed, what it did not do (real code unchanged, nothing committed or deployed, other callers unchecked), and that the spec needs a person's decision.

## The page afterwards
- Team view: the suggested spec (1 scenario, "Evidence names this scenario", Accept and Discard), the evidence "Reported by Demo visitor ea29379c (AI agent)", and the review request as an internal note.
- Customer view: the check and the evidence with its label. No spec and no note.

## Not done
Nobody accepted the spec or asked the customer, since those steps belong to people. The fix was tested on a copy of the ticket's snippet, not on real code.

Files kept here: `transcript.public.jsonl` (the run as it happened, with local file paths replaced and checked for keys) and the two files the assistant wrote, `sup4/total.js` and `sup4/total.test.js`.
