# How the code is laid out

An Express server in TypeScript (strict) with a SQLite database through `better-sqlite3`, pages
rendered on the server with EJS and the Pico CSS stylesheet, and GitHub sign-in through Better
Auth. Inputs are checked with zod.

## Layers

- **Routes** only read the request and call the service. The pages, the JSON API
  ([`API.md`](API.md)) and the MCP endpoint for AI assistants all call the same service
  functions.
- **The ticket service** holds the rules and the transactions.
- **Repositories** hold the ticket, connection and team-list SQL. Startup checks and sign-in
  lookups keep a few queries of their own.

## Permissions

`can()` in `src/server/permissions.ts` decides by role, by agent scope and by who filed the
ticket, for people and for agents, whatever the door (a page, the JSON API or an agent tool).
Its table, `CAPABILITIES`, says for each action which people may take it and which agent scope it
needs, or that it is for people only. Who owns the ticket and the order of the workflow are
checked in the ticket service: for example, only the ticket's owner asks the customer, and only
once work has started and the change is linked.

## The ticket's life

- **Three statuses**: New, In Progress and Resolved.
- The customer's Yes to "Did this fix it?" resolves a ticket as "Customer confirmed". Its owner or
  an admin can also resolve it with a required reason, shown everywhere as "Resolved by the team:
  <reason>". The customer can reopen either. An agent never resolves.
- Every ticket in progress has a named person who owns it, never an agent.
- **History is add-only.** Every change writes a history entry in the same transaction, saying
  who did it and whether they were a person or an agent. Database triggers refuse to change it.
- **Agents are connections**, with keys stored only as a hash. The MCP endpoint is built with the
  official MCP TypeScript SDK.

## Files

- `src/server/app.ts` builds the app; `src/server/index.ts` starts it; `src/server/start.ts`
  opens and migrates the database, refusing one labelled for the other purpose first.
- `src/server/routes/` holds the thin routes: `pages.ts` for the pages, `tickets.ts` for the JSON
  API, `connections.ts`, `sign-in.ts`.
- `src/server/tickets/` holds the ticket service, its repository and schemas.
- `src/server/permissions.ts` holds `can()` and the capability table.
- `src/server/mcp.ts` is the MCP endpoint; `src/server/connections/` the agent connections;
  `src/server/team/` who can own a ticket.
- `views/` holds the page templates; `public/theme.css` every colour and font.
- `migrations/` holds numbered SQL files; `tests/` the tests; `ops/prove/` the patch checker.

## Design debt

Shortcuts in the code that were kept for now, each with the plan for it.

- **One large ticket service.** `src/server/tickets/service.ts` is over 2,000 lines doing about
  eight jobs: workflow, conversation, evidence, specs, retries, demo seeding, demo visibility and
  page helpers. It will be split behind the same exports, with the test suite as the safety net.
- **Visibility is decided inline.** Who sees which rows (the customer, a handed agent, a demo
  agent, a notes reader) is checked in about 25 places across the read paths. The next read
  path, such as reports, goes through one visibility module first.
- **Owner and state checks are written twice.** `can()` knows nothing of who owns a ticket or
  what state it is in. Each command checks ownership and state itself, and the ticket page
  restates those checks to choose its controls. The plan is one precondition per command, which
  the command throws and the page reads, so the two cannot disagree.
- **Writes return hand-built rows.** A write command returns a copy of the row built by hand
  instead of reading it back, in about a dozen places. They match the SQL today and one that did
  not was fixed, but the pattern can drift.
- **Two dispatch wrappers.** The JSON API and the MCP endpoint each wrap the same action table in
  about 30 lines of their own. Two actions, `add_note` and `ask_owner_to_review`, parse their
  input in that table rather than in the service.
- **A few queries outside the repositories.** The startup checks and the sign-in lookup run their
  own SQL. The error module imports a page helper, so the error types depend on page code.
- **Loose ends in the schema.** `tickets.agent_id` is kept but never written. The later link
  columns (`ticket_evidence.spec_id` and `connection_id`, `ticket_specs.connection_id`,
  `ticket_entries.based_on`) have no `REFERENCES` clause and are checked in code only.
- **Event types and error codes are plain strings.** The tests check them; the compiler does not.
- **Two compatibility branches have no test:** the lookup for a No recorded before comments were
  kept, and a demo seed recorded before the sample for assistants was named. They stay until the
  live databases are checked, then go or get a test.
- **Test setup is copied between files.** Several files build their own ask-the-customer setup,
  agent keys are issued by reading the admin page, files are named after pull requests rather
  than rules, and the people side of the permission rules is picked by hand rather than
  generated from the table.
