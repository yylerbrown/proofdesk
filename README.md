# Proofdesk

A support desk where the customer says how to check a fix and gets to say whether it worked.

A test can pass while the customer is still stuck. The team and its assistant see the customer's
words and record what they tried. If the fix misses, the ticket goes back to someone the customer
already knows.

- **The demo, no account needed: <https://support-desk-demo.fly.dev>.** Sample data, shared with
  everyone who visits, so do not type anything private.
- **The real site, with GitHub sign-in: <https://proofdesk.fly.dev>.**
- **The source: <https://github.com/yylerbrown/proofdesk>.**

## The rubric, line by line

Each one takes under a minute on the demo, starting from its welcome page.

**Ticket submission: title, description, status**

- Start as: The welcome page
- Press: **Try the ticket workflow**, then **File ticket**
- You should see: The form says "Initial status: New" and is filled with a sample you can change. The filed ticket shows **New**.

**Ticket list with filters**

- Start as: **View as Demo Team Member**
- Press: **Tickets**, then **New**, **In Progress**, **Resolved**; **Mine** and **Unassigned**; or type words and press **Search**
- You should see: "All tickets", and each filter changes the list. They combine in the address, so a filtered view can be shared. A customer's list is "My tickets": only their own, with the search.

**Update status: New to In Progress**

- Start as: Demo Team Member, on a New ticket
- Press: **Take ticket and start work**
- You should see: **In Progress**, with you as its owner.

**Update status: to Resolved**

- Start as: Demo Team Member, owning the ticket
- Press: **Use sample fix** (or type any link and press **Save change link**), then **Ask the customer to verify**, then **View this ticket as the customer who filed it** and **Yes, resolve ticket**
- You should see: **Resolved**, and "Customer confirmed it is fixed." Wherever the team looks for Resolved, the page says the customer confirms a fix with Yes, and that the team can also resolve with a reason: as the owner, open "Resolve with a reason" under Status, and the ticket then shows "Resolved by the team: <reason>" to everyone.

**A working product**

- Start as: The welcome page
- Press: **Try the ticket workflow**
- You should see: One ticket from New to Resolved, switching role on the same ticket, in about two minutes.

**Source on GitHub, and a README on how to run it**

- Start as: [github.com/yylerbrown/proofdesk](https://github.com/yylerbrown/proofdesk)
- Press: [Run it yourself](#run-it-yourself)
- You should see: A copy running on your own machine.

**Bonus: a live URL**

- Press: The two links above
- You should see: The demo, and the real site.

**Bonus: SSO with roles and permissions**

- Start as: The real site
- Press: **Sign in with GitHub**
- You should see: Signed in as a customer, a team member or an admin, set by GitHub user numbers. On the demo the three roles are offered by name, the admin as **Admin preview (read-only)**.

**Bonus: AI features**

- Start as: The welcome page
- Press: **Get a demo connection**, then paste the command into your own assistant, for example Claude Code
- You should see: Your assistant, through MCP, reads a sample ticket and its check, proposes a test spec, writes notes and attaches evidence. Proofdesk makes no model calls of its own. **See an assistant's work**, also on the welcome page, shows one real run: its summary, transcript and files, and the ticket it left on the demo.

**Bonus: creative extras**

- Start as: Any ticket
- Press: **How will we know it's fixed?** on the form; **Did this fix it?** for the customer
- You should see: The customer's own check stays on the ticket. Only their Yes resolves. A No goes back to the named owner with their words. Evidence is labelled as reported, never as verified. The history cannot be changed.

Tickets start New, move to In Progress when work starts, and become Resolved when the customer
who filed them confirms the fix.

## Who can do what on the demo

- **Demo Customer**
  - Can: File a ticket. Read, edit and reply on the tickets the Demo Customer filed (every visitor shares this one customer). Answer "Did this fix it?" on them.
  - Cannot: See the team's internal notes, change a status, archive or delete.
- **Demo Team Member**
  - Can: See every ticket. Take one and start work, reply, write internal notes, offer a clearer check, link the code change, attach evidence, ask the customer to verify, and resolve a ticket they own with a reason (shown as resolved by the team).
  - Cannot: Confirm a fix (only the customer can), archive, restore or delete.
- **Admin preview (read-only)**
  - Can: See everything, archived tickets included.
  - Cannot: Change anything, so no visitor can empty the demo.

To change role, open **Switch role** beside "Signed in as" in the header and pick another
person: you stay on the same page. On the real site, everyone who signs in is a customer, except the GitHub accounts
the owner has named as team members or admins.

## Connect your own AI assistant

Proofdesk gives your agent the customer's definition of "fixed", and gives the customer the
final say on whether the fix worked. The customer's check is direction for the agent, not its
acceptance test: a test can pass while the customer is still stuck.

Proofdesk makes no AI calls of its own. A person's own assistant can work on tickets through an
MCP endpoint, with only the permissions its connection allows. On the demo, choose **Get a demo
connection** on the welcome page: you get your own key for a day, and the command to paste.
For Claude Code it looks like this:

```bash
claude mcp add --transport http proofdesk \
  https://support-desk-demo.fly.dev/mcp \
  --header "Authorization: Bearer <your key>"
```

Your assistant sees only the sample ticket made for assistants, which is handed to every visitor's
connection, and what it writes itself, never what other visitors' assistants write. It can read a ticket (which starts with the customer's check, as `done_when`), attach
evidence, and ask the owner to request the customer's check; it can never answer for the
customer or resolve. On the real site an admin issues connections on the **Connections** page
(linked from an admin's ticket list), and a ticket's owner hands the ticket to one with **Hand to an AI assistant**: an assistant sees
only the tickets handed to it.
[`docs/AGENTS_GUIDE.md`](docs/AGENTS_GUIDE.md) has the setup for Claude Code and Claude Desktop,
the tools, the limits and a worked example.

## Run it yourself

Check `node -v` first: Node 22.14 or newer (`.nvmrc` says 22). Older versions are refused by
`npm ci`, because a dependency needs it. With nvm: `nvm install 22 && nvm use 22`.

Get the source:

```bash
git clone https://github.com/yylerbrown/proofdesk.git
```

```bash
cd proofdesk
```

**Development**, with four made-up people and no keys:

```bash
npm ci
```

```bash
DEV_SIGN_IN=on npm run dev
```

Open <http://localhost:3000> and pick a person. It keeps running until you stop it. To keep your
settings in a file instead, copy `.env.example` to `.env`, which turns the development entrance
on; `npm run dev` reads it.

**The demo, locally**, on its own database:

```bash
DEV_SIGN_IN=off DEMO=on \
  DATABASE_PATH=./data/demo.db npm run dev
```

**A production build** reads only real environment variables, never `.env`:

```bash
npm run build
```

```bash
NODE_ENV=production DEMO=on \
  DATABASE_PATH=./data/demo.db npm start
```

For the real thing, leave out `DEMO=on` and pass the four GitHub settings below as real
environment variables, with an https `BETTER_AUTH_URL` and a database of its own, such as
`DATABASE_PATH=./data/app.db`. Production refuses an http address, and the server refuses a
demo database for real tickets.

**Docker.** Without keys, a container can only run as the demo. Give the demo its own volume: a
database records for good whether it is for the demo or for real tickets.

```bash
docker build -t proofdesk .
```

```bash
docker run --rm -p 3000:3000 -e DEMO=on \
  -v proofdesk-demo:/data proofdesk
```

A real run needs the four GitHub settings, with `-e` or `--env-file`, and a different volume.
`PORT` changes the port inside the container, so `-e PORT=8080` needs `-p 8080:8080`.

### Settings

All of them are in `.env.example`, with comments.

| Name                                                                                | What it does                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                          | `development`, `test` or `production`. Production refuses the development entrance and requires https sign-in.                                                              |
| `PORT`                                                                              | Default 3000.                                                                                                                                                               |
| `DATABASE_PATH`                                                                     | The SQLite file. Default `./data/app.db`.                                                                                                                                   |
| `TICKET_PREFIX`                                                                     | The letters before a ticket's number, default `SUP`. Fixed when the database is created.                                                                                    |
| `DEV_SIGN_IN`                                                                       | `on` offers four made-up people. Development only.                                                                                                                          |
| `DEMO`                                                                              | `on` makes this server the demo: sample data, three demo people, no GitHub sign-in.                                                                                         |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in. All four or none. Required in production unless `DEMO=on`.                                                                                                  |
| `TEAM_GITHUB_IDS`, `ADMIN_GITHUB_IDS`                                               | GitHub user numbers, separated by commas. Everyone else is a customer.                                                                                                      |
| `CLIENT_IP_HEADER`                                                                  | Behind a proxy, the header with the visitor's address, for rate limits. Fly.io: `fly-client-ip`.                                                                            |
| `DEMO_URL`                                                                          | Optional, on the real site: the demo's https address, linked from the sign-in page as "Try the demo without signing in".                                                    |
| `REAL_SITE_URL`                                                                     | Optional, on the demo: the real site's https address, named on the welcome page as where GitHub sign-in with roles runs.                                                    |
| `SOURCE_URL`                                                                        | Optional: the repository's https address. The welcome page then links **Source and setup** to its README, and `GET /api` names it. Both Fly apps set it to the public copy. |
| `PUBLIC_URL`                                                                        | Optional: the address people and assistants reach this server at, for the commands to paste. Else `BETTER_AUTH_URL`, else each request's own address. The demo sets it.     |
| `GIT_COMMIT`                                                                        | Reported by `GET /api/health`.                                                                                                                                              |

### GitHub sign-in

1. On GitHub, **Settings → Developer settings → OAuth Apps → New OAuth App**. Homepage URL: your
   address, for example `http://localhost:3000`. Authorization callback URL: the same address
   followed by `/api/auth/callback/github`.
2. Put its client id and a new client secret in `.env`, with `BETTER_AUTH_URL` set to the same
   address and `BETTER_AUTH_SECRET` set to the output of `openssl rand -base64 32`.
3. Set `DEV_SIGN_IN=off`. To make yourself an admin, put your GitHub user number (the `id` at
   `https://api.github.com/users/<your user name>`) in `ADMIN_GITHUB_IDS`.

The `.env` file and the http address are for `npm run dev`. A production build (`npm start`)
does not read `.env` and refuses an http address: pass the four settings as real environment
variables, with an https `BETTER_AUTH_URL` and its own `DATABASE_PATH`, such as
`./data/app.db`.

## What's next

Each accepted scenario of a ticket's test spec gets a permanent id, such as `SUP-42/S1`, carried in
the name of the test in the product's own repository, and the desk records only "Reported passing
at commit <sha>"; the rest of the plan is in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## How it is built

An Express server in TypeScript (strict) with a SQLite database through `better-sqlite3`, pages
rendered on the server with EJS and the Pico CSS stylesheet, and GitHub sign-in through Better
Auth. Inputs are checked with zod.

- **Three layers.** Routes only read the request and call the service. The service holds the
  rules and the transactions. The repositories hold the ticket, connection and team-list SQL;
  startup checks and sign-in lookups keep a few queries of their own.
- **One permission function**, `can()` in `src/server/permissions.ts`, decides by role, by who
  filed the ticket and by agent scope, for people and for agents, whatever the door (a page, the
  JSON API or an agent tool). The service adds the owner and state rules, such as only the
  ticket's owner asking the customer, and only once work has started and the change is linked.
  Its table, `CAPABILITIES`, says for each action which people may take it and which agent
  scope it needs, or that it is for people only.
- **Three statuses**: New, In Progress and Resolved. The customer's Yes resolves a ticket as
  "Customer confirmed"; its owner or an admin can also resolve it with a reason, shown everywhere as
  "Resolved by the team: <reason>", and the customer can reopen either. An agent never resolves.
  Every ticket in progress has a named person who owns it, never an agent.
- **History is add-only.** Every change writes a history entry in the same transaction, saying
  who did it and whether they were a person or an agent. Database triggers refuse to change it.
- **Agents are connections**, with keys stored only as a hash. The JSON API and the MCP endpoint
  (built with the official MCP TypeScript SDK) call the same service functions as the pages.

## How it is verified

| Command                | What it runs                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`             | Every unit and route test with vitest: about 800.                                                                                                                               |
| `npm run test:browser` | One real-browser journey with Playwright: a customer files, the team works it, No then Yes, and a second customer is refused. Run `npx playwright install chromium` once first. |
| `npm run typecheck`    | TypeScript, strict.                                                                                                                                                             |
| `npm run lint`         | ESLint.                                                                                                                                                                         |
| `npm run format:check` | Prettier, without changing files. `npm run format` rewrites them.                                                                                                               |

CI runs all of them on every pull request. Many changes were also broken on purpose to see their
test fail; each pull request says which.
Pull request numbers, here and in [`BUILD_LOG.md`](BUILD_LOG.md), refer to the private working
repository, which stays private; the public copy's `docs/PULL_REQUESTS.md` holds each one's title
and description.

## How the work was directed

An AI coding assistant wrote the implementation. The owner defined the behaviour, broke the work
into small changes and directed the checking, including outside reviews of the design and the
code. The specification ([`docs/SPEC.md`](docs/SPEC.md)), the history of every step
([`BUILD_LOG.md`](BUILD_LOG.md)) and the checks are in the repository.

## Known limits

- **Last writer wins** for edits to a ticket and to the team's check. Only the customer's answer
  carries a version check, so an old page cannot answer a newer question.
- **Evidence is reported, not verified.** Proofdesk shows who reported it and checks none of it.
- **No email.** Nobody is told when something changes; people look at the ticket.
- **The development cookie is unsigned.** It is safe only because production refuses the
  development entrance.
- **One machine.** SQLite on one disk; rate-limit counts are in memory and reset on a restart.
- **`ops/prove` is not a sandbox.** It runs the candidate code on the machine with only the
  environment cleaned, and its check for skipped or focused tests is a text match.
- **Permanent deletion** does not reach backups, the host's snapshots of the disk until they
  expire, or anything already sent elsewhere.
- **Left out of the workflow on purpose:** an immutable record of each question asked, beyond
  the history entry; human review decisions recorded against each piece of evidence;
  reassigning tickets when someone leaves the team; documentation generated from conditional
  rules; and upgrading tickets resolved before the customer's Yes was required.
- **Demo visitors share identities.** Everyone who views as Demo Customer is the same customer.
- **Not built on purpose:** a board with status columns or dragging, priority ordering, closing a
  ticket without the customer, and any model call of the site's own.

## Known limits and design debt

Shortcuts in the code that were kept for now, each with the plan for it.

- **One large ticket service.** `src/server/tickets/service.ts` is about 1,900 lines doing about
  eight jobs: workflow, conversation, evidence, specs, retries, demo seeding, demo visibility and
  page helpers. It will be split behind the same exports, with the test suite as the safety net.
- **Visibility is decided inline.** Who sees which rows (the customer, a handed agent, a demo
  agent, a notes reader) is checked in about 25 places across the read paths. The next read
  path, such as search or reports, goes through one visibility module first.
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

---

## Reference

### JSON API

Every route is under `/api` and speaks JSON. The routes are built from one table, `ACTIONS` in
`src/server/api/actions.ts`, and a test checks this list against it. `GET /api` is a guide for
agents, and `GET /api/openapi.json` the full description, generated from the same table.

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

With the development entrance on, the API can be tried with `curl` and a cookie. The people are
`dev-customer-1`, `dev-customer-2`, `dev-team-1` and `dev-admin-1`:

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

### Security

Each item has a test that fails if it is removed (`tests/security.test.ts` unless another is
named).

- Every SQL statement is a fixed string with bound values, except one in demo seeding that names
  its table from a fixed list in the code, never from input.
- Templates escape ticket text; links are limited to http and https.
- `helmet` sets the security headers; the content security policy allows scripts and styles
  only from this server, and no page has an inline script or style.
- A write must come from a page on this site (`src/server/same-origin.ts`), or carry an agent's
  connection key, which a browser never adds by itself.
- Sessions are kept by the sign-in library in the database; GitHub tokens are stored encrypted;
  account linking is off; production requires https.
- Rate limits: 20 new tickets per ten minutes per person, 10 sign-in starts a minute per
  address, and 120 writes per ten minutes across pages, API and tools, per person or connection
  (per address on the demo). The demo also has a hard row budget.
- Answers to signed-in people are never cached. A request body over 100 KB is refused.
- The permission rules are tested on the real routes (`tests/roles.test.ts`,
  `tests/capabilities.test.ts`, `tests/connections.test.ts`).

### Permanent deletion

An admin opens a ticket, follows "Delete permanently" and types its key. In one transaction the
ticket and every row that belongs to it are removed; only its number, the time and who deleted it
are kept, and the number is never given to a new ticket. The deleted text is also wiped from the
database files, and a test searches the raw files for it. Every table whose rows belong to a
ticket carries a `ticket_id` column, and a test fails if one is missing from the deletion.

### Deploying

Two Fly.io apps in `sjc`, both described in [`docs/DEPLOY.md`](docs/DEPLOY.md), each with one
machine and its own disk: `support-desk-demo`, the demo, deployed with `fly.toml`; and
`proofdesk`, the real site.

**The real site always deploys with `--config fly.proofdesk.toml`.** `fly.toml` sets `DEMO=on`,
and the real site refuses to start with it, as designed.

The demo adds its samples only to an empty database. To reset it, move `app.db`, `app.db-wal`
and `app.db-shm` aside on its disk and restart the machine. After a deploy, check
`/api/health` on both, and that the demo's welcome page offers **Get a demo connection**.

### Layout

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

### History

How each step was asked for, what came back and what was found is in [`BUILD_LOG.md`](BUILD_LOG.md).
What was decided, and when it changed, is in [`docs/SPEC.md`](docs/SPEC.md).
