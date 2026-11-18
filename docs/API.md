# JSON API

Every route is under `/api` and speaks JSON. The routes are built from one table, `ACTIONS` in
`src/server/api/actions.ts`, and `tests/readme.test.ts` checks this list against it. `GET /api`
is a guide for agents, and `GET /api/openapi.json` the full description, generated from the same
table. AI assistants reach the same actions as MCP tools; [`AGENTS_GUIDE.md`](AGENTS_GUIDE.md)
covers that side.

## Routes

| Route                                      | What it does                                                                                                                                                                                                | Body                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/tickets`                         | Lists tickets in the same order as the page: open ones newest first, then resolved ones. `?status=new`, `in_progress`, `resolved`, `all` or `archived`; 100 a page, the next page named in a `Link` header. |                                                                                              |
| `POST /api/tickets`                        | Files a ticket. Returns 201.                                                                                                                                                                                | `{ "title", "description", "where_url"?, "fix_check"? }`                                     |
| `GET /api/tickets/:key`                    | One ticket, starting with `done_when` (the checks) and `waiting_on`.                                                                                                                                        |                                                                                              |
| `PATCH /api/tickets/:key`                  | Starts work: moves a New ticket you own to `in_progress`. Nothing else.                                                                                                                                     | `{ "status": "in_progress" }`                                                                |
| `PUT /api/tickets/:key`                    | Replaces the ticket's text.                                                                                                                                                                                 | Same as filing.                                                                              |
| `PUT /api/tickets/:key/agreed-check`       | Sets the team's check. Empty removes it. The customer's own words never change.                                                                                                                             | `{ "agreed_check": "..." }`                                                                  |
| `POST /api/tickets/:key/adopt-check`       | The customer adopts the team's check as their own check.                                                                                                                                                    |                                                                                              |
| `PUT /api/tickets/:key/change-link`        | Links the code change.                                                                                                                                                                                      | `{ "change_url": "https://..." }`                                                            |
| `POST /api/tickets/:key/ready`             | The owner asks the customer "Did this fix it?", saying what they tried and what happened. Needs In Progress and a change link; after a No, `response` too.                                                  | `{ "try_url", "tried", "result", "response"?, "evidence_ids"? }`                             |
| `POST /api/tickets/:key/withdraw-question` | The owner takes back a question the customer has not answered. Asking again with the same details is a retry; with different ones, withdraw first.                                                          |                                                                                              |
| `POST /api/tickets/:key/answer`            | The customer's answer. Yes resolves; No needs a comment.                                                                                                                                                    | `{ "fixed": "yes" or "no", "ready_token": "...", "comment"? }`                               |
| `POST /api/tickets/:key/take-and-start`    | Takes an unowned New ticket and starts work on it, in one step.                                                                                                                                             |                                                                                              |
| `POST /api/tickets/:key/reopen`            | The customer who filed a resolved ticket says it is still happening. It goes back to its owner.                                                                                                             | `{ "reason": "..." }`                                                                        |
| `POST /api/tickets/:key/resolve`           | The ticket's owner or an admin resolves a New or In Progress ticket without the customer's Yes, with a reason. It shows as resolved by the team; the customer can reopen it. Never an agent.                | `{ "reason": "wont_fix", "note": "..." }` (`duplicate_of` for a duplicate; `note` for other) |
| `POST /api/tickets/:key/take`              | Makes you the owner of an unowned ticket.                                                                                                                                                                   |                                                                                              |
| `POST /api/tickets/:key/hand-off`          | The owner, or an admin, hands the ticket to another team member.                                                                                                                                            | `{ "to": "<person id>", "expected_owner": "<current owner id>" }`                            |
| `POST /api/tickets/:key/agent`             | The owner hands an in-progress ticket to one agent connection, which can then work on that ticket only.                                                                                                     | `{ "connection_id": 1 }`                                                                     |
| `POST /api/tickets/:key/agent/end`         | The owner, or an admin, ends the agent's work on the ticket.                                                                                                                                                |                                                                                              |
| `POST /api/tickets/:key/release`           | The owner lets go of a New ticket.                                                                                                                                                                          |                                                                                              |
| `POST /api/tickets/:key/archive`           | Hides it from the lists. Nothing is deleted.                                                                                                                                                                |                                                                                              |
| `POST /api/tickets/:key/restore`           | Brings an archived ticket back.                                                                                                                                                                             |                                                                                              |
| `DELETE /api/tickets/:key`                 | Deletes it permanently. Admin only.                                                                                                                                                                         | `{ "confirm": "SUP-42" }`                                                                    |
| `GET /api/tickets/:key/entries`            | The conversation. A customer never sees internal notes; an assistant sees them only with the `read_notes` scope.                                                                                            |                                                                                              |
| `POST /api/tickets/:key/entries`           | A reply, or an internal note for the team.                                                                                                                                                                  | `{ "kind": "reply" or "note", "body": "..." }`                                               |
| `POST /api/tickets/:key/notes`             | An internal note for the team; how an agent writes.                                                                                                                                                         | `{ "body": "..." }`                                                                          |
| `GET /api/tickets/:key/evidence`           | The evidence, as reported.                                                                                                                                                                                  |                                                                                              |
| `POST /api/tickets/:key/evidence`          | Attaches evidence. Never resolves.                                                                                                                                                                          | `{ "kind", "summary", "link"?, "revision"?, "command"?, "result"? }`                         |
| `POST /api/tickets/:key/spec`              | An agent proposes a test spec; a person decides.                                                                                                                                                            | `{ "summary", "scenarios" }`                                                                 |
| `POST /api/tickets/:key/spec/decision`     | A person accepts or declines the proposed spec.                                                                                                                                                             | `{ "decision": "accept" or "discard" }`                                                      |
| `POST /api/tickets/:key/owner-review`      | Asks the owner to review the evidence, as an internal note. It does not contact the customer.                                                                                                               | `{ "message": "..." }`                                                                       |
| `GET /api/tickets/:key/events`             | The history: who did what, and whether a person or an agent.                                                                                                                                                |                                                                                              |
| `GET /api/health`                          | Server and database state.                                                                                                                                                                                  |                                                                                              |

`ready_token` comes from the ticket once the team has asked; it makes sure the customer answers
the question they were shown. Errors look like
`{ "error": { "code", "message", "hint", "retry" } }`: the hint says what to do next. A write
sent with an `Idempotency-Key` header is done once, however often it is retried.

## Trying it with curl

With the dev login on (`DEV_SIGN_IN=on`), the API can be tried with `curl` and a cookie. The
people are `dev-customer-1`, `dev-customer-2`, `dev-team-1` and `dev-admin-1`:

```bash
curl -c jar -H "Origin: http://localhost:3000" \
  -d id=dev-customer-1 http://localhost:3000/sign-in/dev
```

```bash
curl -b jar -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/json" \
  -d '{"title": "Printer jams",
       "description": "On page two",
       "fix_check": "Ten pages print"}' \
  http://localhost:3000/api/tickets
```

```bash
curl -b jar http://localhost:3000/api/tickets
```

These use the default port. With `PORT` set to another one, change the address and the `Origin`
header to match it, or the API answers `cross_site_request`.
