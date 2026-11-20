# Dogfooding run: Proofdesk faults filed, fixed and checked through Proofdesk

**When:** 20 Nov 2026, UTC. Listener 03:04:28 to 03:05:18 UTC; filing 03:04:57 to 03:05:14; fixer 03:10:38 to 03:20:06; person-side check and "Mark fixed" about 03:21 to 03:23.
**Product:** a local Proofdesk on port 4170, run from a worktree of the repository (branch `fix/dogfood-run`, cut from main `8e2a336`), development entrance on, DEMO off, a throwaway database in a temporary folder. Never the live sites.
**Assistant:** Claude Code, headless, model alias `opus`, reported as `claude-opus-5-5`. The listener reported Claude Code 2.1.319; the fixer run reported 2.1.329 (the CLI updated itself between the two).
**Outcome:** three real faults filed as tickets by the customer through the pages. The listening assistant offered ways to prove each fix within 4 to 5 seconds of the second step opening. The fixer fixed all three in the code, each with a test that fails without it, committed each, attached evidence naming the proof and asked the owner to review. A person checked each fix (tests, undo, fail, restore, and the customer's own proof live), marked each fixed, and the customer answered Yes to each. Pull request #201, head `3b6293a`.
**Not clean:** the first fixer run was blocked by the permission settings the person running it had written, and changed nothing; the person corrected the settings and ran it once more with the same prompt (details under "What went wrong").

## Human steps

1. Admin (development entrance, "View as Admin"), Connections: issued "Dogfood assistant" with read tickets, write notes, attach evidence, propose specs and link changes; Suggestions: Automatic. The person's script lost the first key it was shown (a page-reading bug in that script), so the person revoked that connection and issued a second. The key went straight from the page into a mode 600 file in the temp folder and was never printed.
2. Before filing, the person confirmed each fault (below). The fault 2 and 3 probes ran on separate throwaway servers.
3. Started the listener, then filed the three tickets as Customer One: the form, "File ticket", then on "What would prove it is fixed?" waited for the assistant's choices, picked the first one unedited, and pressed "Save".
4. As Team Member, on each ticket: "Take ticket and start work", then More options, "Hand to an AI assistant", "Dogfood assistant", "Hand to assistant". On SUP-1 the person also tried the fault itself: a PATCH to status resolved answered 409 `needs_customer` with the old wording.
5. Ran the fixer (twice; see below).
6. Person-side check (below), restarted the 4170 server on the fixed code, then as Team Member pressed "Mark fixed and tell the customer" on each ticket, and as Customer One pressed "Yes, it is fixed" on each after checking its proof.

## Faults confirmed before filing

1. **Retired button name in a refusal.** `/llms.txt` on the local server, Errors table, `needs_customer`: "...which its owner asks with Ask the customer to verify (POST /api/tickets/{key}/ready)". The ticket page's step is "Mark fixed and tell the customer" (posts a resolve with reason fixed), and asking first is "Ask before resolving" under More options. Seen live again in step 4.
2. **A cancelled wait keeps its place.** Reproduced on a separate throwaway server with five connections and the official MCP SDK client: four held `wait_for_requests` calls, call 1 cancelled through the SDK's abort signal (it sends `notifications/cancelled` and keeps the request open), and at 1.5 s the fifth connection was refused with `too_many_requests` "already holds 4"; it was held only after the 20 s deadline. The first probe passed the abort signal in the wrong argument and showed nothing; the person fixed the probe and ran it again.
3. **The person's own find (rules/API), about ten minutes of reading:** the default list order `open_first` is described in the `order` field, the `list_tickets` summary and `/llms.txt` as "open tickets newest first, then resolved ones", but the SQL puts New tickets that say how to verify first. Reproduced: an older ticket with a proof listed before a newer one without.

## How it was run

Server (temp folder as `$T`):

```sh
NODE_ENV=test PORT=4170 DATABASE_PATH=$T/app.db DEV_SIGN_IN=on TICKET_PREFIX=SUP DEMO=off \
  BETTER_AUTH_SECRET= BETTER_AUTH_URL= GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= npx tsx src/server/index.ts
```

MCP config (`mcp-config.json`): `http://127.0.0.1:4170/mcp` with `"Authorization": "Bearer ${PROOFDESK_KEY}"`; the key read from the private file into the environment only. Both runs use `env -i` (HOME, PATH, USER, LANG and the key only), `--setting-sources project --no-session-persistence --strict-mcp-config`, stream-json output.

**Listener** (`run-listener.sh`), from an empty folder in the temp folder, sandbox on, home unreadable, only `mcp__proofdesk` allowed:

```sh
claude -p --model opus --setting-sources project --no-session-persistence \
  --mcp-config mcp-config.json --strict-mcp-config \
  --settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":false,"allowUnsandboxedCommands":false},"permissions":{"deny":["Read(~/**)"]}}' \
  --allowedTools "mcp__proofdesk" --output-format stream-json --verbose "<prompt>"
```

**Fixer** (`run-fixer.sh`), started in the worktree. Sandbox on with local port binding (tests listen on 127.0.0.1); the home folder unreadable to commands except the worktree, the main repository's `.git` (the worktree's objects live there), git config and Node; the file tools denied the private folders and the key's folder. Allowed: `mcp__proofdesk`, `Read(./**)`, `Edit(./**)`, `Bash(npm *)`, `Bash(npx *)`, `Bash(node *)`, `Bash(git *)`. Exact settings are in the script. Network out was denied by the sandbox (npx's registry lookups show as sandbox violations in the transcript; nothing needed the network).

## The prompts, word for word

Listener:

> Using Proofdesk, listen for customers who want ways to prove their new ticket is fixed. Call wait_for_requests, and whenever it hands you a request, answer it at once with answer_request: up to three short ways the customer could check the fix themselves, each built only from what the ticket says. Then call wait_for_requests again. Keep going until you have answered three requests, or until ten calls in a row bring nothing. Do not claim anything you did not observe.

Fixer (both runs, identical):

> Using Proofdesk, find the tickets handed to you. For each one, read its problem and what would prove it is fixed. Fix it in this repository with a test that fails without the fix, and run the tests (other people run tests on this machine, so use --maxWorkers=4 for the whole suite). Change only files under src/server and tests, and leave views, public, src/browser, src/server/routes/pages.ts, src/server/pages, README.md and docs alone. Attach what you observed as evidence, naming the proof, and ask the owner to review. Claim nothing you did not observe. Commit each fix on the current branch. Do not push.

## Listener: calls and results

The opening event shows one server, `proofdesk`, connected, with the 13 tools this connection's scopes allow. 8 turns, 49.6 s, US$0.18.

1. `wait_for_requests` (no arguments) returned request 1, SUP-1. `answer_request` with three options.
2. `wait_for_requests` returned request 2, SUP-2. `answer_request` with two options.
3. `wait_for_requests` returned request 3, SUP-3. `answer_request` with three options. It stopped, saying it had run none of the checks.

What the customer saw on the second step (time from the step page loading to the first choice appearing):

| Ticket                                                      | Suggestions arrived | Saved proof (first choice, unedited)                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SUP-1 "Refusal names a button that no longer exists"        | 4.3 s, 3 choices    | Open /llms.txt, find the needs_customer row in the Errors table, and see that it no longer mentions an "Ask the customer to verify" button                                                          |
| SUP-2 "A cancelled wait keeps its place until its deadline" | 5.3 s, 2 choices    | With four assistants listening, cancel one call with notifications/cancelled, then have a fifth call wait_for_requests half a second later and see it is let in, not refused with too_many_requests |
| SUP-3 "Default list order is not what /llms.txt says"       | 5.3 s, 3 choices    | File an older ticket that says what would prove it is fixed and a newer one that does not, call GET /api/tickets with no order, and see the order matches what /llms.txt says open_first does       |

## Fixer (second run): calls and results

87 turns, 9 min 28 s, US$2.09. `list_tickets` (three rows), then `get_ticket` on SUP-1, SUP-2 and SUP-3. Then, in the code:

- **SUP-2 first.** Read `mcp.ts`, the listening code and the tests from #198, and found that each `/mcp` request builds its own MCP server, so a cancel notification reaches a server that never saw the call. Wrote the test first and saw it fail with the ticket's own `too_many_requests` message; added a shared list of running tool calls keyed by connection and JSON-RPC id; the tests passed (42 of 42 in the two files). Added a test that one connection cannot cancel another's call, broke the scoping on purpose with an edit, saw it fail ("expected 6 to be greater than 1500"), and restored it. Commit `3538083`.
- **SUP-1.** Changed the `needs_customer` hint and the page refusal to name "Mark fixed and tell the customer" (resolves at once) and "Ask before resolving" under More options, with a new test on the `/llms.txt` row; stashed the source change and saw two tests fail, then restored it. The full suite then found three more tests pinning the old words (`confirmation`, `demo-connections`, `mcp`); it updated them and amended them into the SUP-1 commit, `673780f`.
- **SUP-3.** Judged the order deliberate (an existing test pins it) and changed the words, not the order. It wrote `tests/list-order-described.test.ts` first, saw both cases fail, then pass. Commit `3b6293a`.
- The final gate it ran on `3b6293a`: typecheck, lint, format check, full suite 2240 of 2240, build.
- `add_evidence` on each ticket (kind test, the command, "passed with fix; failed without it", the revision, a summary naming the proof), then `ask_owner_to_review` on each, saying what ran and what did not (no browser journey, no deployed site, only the SDK client and raw JSON-RPC for SUP-2).
- Refused by the harness and worked around with the file tools: one `sed -i`, one `perl -pi` using `$TMPDIR`, and one `git rebase` (it amended instead). Every claim in its evidence and notes matches a result in the transcript.

## Person-side check

For each fix, at `3b6293a`: ran the named tests (pass), checked out main's version of only that fix's source files, ran them again (fail), restored them, and `git status` was clean.

- SUP-1: 20 of 20 pass; with `errors.ts` and `workflow.ts` undone, 2 fail.
- SUP-2: 4 pass; with `mcp.ts` undone, the cancel test fails. The cross-connection test passes without the fix by design; the person did not repeat the fixer's break of it.
- SUP-3: 2 pass; with `actions.ts` and `schemas.ts` undone, both fail.
- The customer's own proofs, live. On the restarted 4170 server, `/llms.txt` has no "Ask the customer to verify" (count 0) and shows the new `needs_customer` row. The original SDK probe on a fresh server at the fixed code: the fifth call was held at 1.5 s. An older ticket with a proof and a newer one without, on a fresh server: the older is listed first, and `/llms.txt` now says so.
- Full local gate in the worktree: typecheck, lint, format check, `npx vitest run --maxWorkers=4` (behind a lock shared with other test runs) with 208 files and 2240 tests passed, and the build. Nothing needed fixing by hand.

## What the pages showed afterwards

- Team view, each ticket: Resolved, "Customer confirmed on Nov 19, 2026.", the evidence under "From the AI assistant" (Revision, Command, Result, "Reported by Dogfood assistant (AI assistant)", "Not checked by Proofdesk"), the first run's blocked note (8:09 PM) and the review request (8:19 PM) as internal notes, and the history: filed, customer chose the proof "suggested by Dogfood assistant", assigned, In Progress, handed to the assistant, note, evidence, review requested, assistant stopped (team resolved), "Resolved by the team: Fixed", "Customer confirmed". The final screenshots have every fold opened.
- Customer view: "Resolved, customer confirmed", the proof and the evidence; no notes.
- List (team, All): three Resolved tickets, each with the solid green check in the Proof column.

## Time and cost

Listener 49.6 s, US$0.18. Fixer run 1 51.7 s, US$0.34. Fixer run 2 9 min 28 s, US$2.09. List prices, as the transcripts report them.

## Pull request

#201, "A cancelled assistant call frees its place at once, and refusals and the list order say what the product does today", head `3b6293a`, three commits, not merged and not queued when this record was written. It was merged afterwards.

## Not done / what went wrong

- **Fixer run 1 failed because of the settings the person running it had written.** They denied `Read(~/**)` in the permissions, which also blocks the file tools in the worktree (a deny beats the `Read(./**)` allow). Their sandbox probe had checked only shell commands, not the Read tool. The run read the three tickets, wrote a blocked note on each saying it could not read the repository, changed nothing and stopped (17 turns, 51.7 s). It did not try to get round the block. The person moved the deny to named private folders, kept the home folder unreadable to shell commands through the sandbox, also denied the key's folder (a second probe showed a shell command could read it), and ran the fixer once more with the identical prompt. That is the one rerun allowed for a setup mistake. Run 1's transcript is kept beside this record, and its blocked notes stay on the tickets.
- The person's connection script lost the first key it was shown; that connection was revoked and a second issued.
- The key is in the assistant process's environment, so a command it runs could read it; the same was true of the first recorded run.
- The listener prompt names the stopping point of three requests because the person running it knew three would be filed.
- The person picked the first suggestion on each ticket without editing it. SUP-1's first choice checks only `/llms.txt`, not the page refusal; the fix covers both.
- The person restarted the 4170 server on the fixed code before marking the tickets fixed, so the customer's checks ran against the fix. The listener and the fixer ran against the server on main's code.
- Each commit was not gated on its own; the gate ran on the last one. The browser journey (`npm run test:browser`) was not run; no page changed.
- While the fault 2 probe server ran on port 4171, two tickets the person did not file ("Export is empty for the button", "Export is empty with nobody listening") appeared in it at 03:01:55 UTC: another session's tool was using that port. The person stopped that server at once and used 4172 for the later probes.
- Nobody accepted a spec (none was proposed), and nothing was deployed.

## Faults noticed in the product along the way (not fixed here)

- The development entrance still describes Team Member as "ask the customer to check the fix", and the customers as following a ticket "until the team asks whether it is fixed", from before "Mark fixed and tell the customer".
- On the team's ticket page the assistant's evidence is folded under "From the AI assistant" / "Details", so "Mark fixed and tell the customer" can be pressed without the evidence ever being shown.
- `/llms.txt` says "Who may: Nobody: an assistant listens..." for `wait_for_requests` and "Nobody: an assistant answers..." for `answer_request`, which reads as if no one may call them.
- An assistant's earlier "Blocked" note stays in the conversation after the same assistant later succeeds, with nothing marking it as superseded.
- A cancel is matched by connection and JSON-RPC id, so two clients sharing one key and the same id could cancel each other's call.

## Files

`transcript.public.jsonl` is the fixer's second run as it happened, with local paths, the account name and the author replaced, and checked for keys. The listener's transcript (`listener.transcript.public.jsonl`) and the blocked first run (`fixer-run-1.transcript.public.jsonl`) are kept beside it in the same form.
