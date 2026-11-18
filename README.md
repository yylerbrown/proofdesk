# Proofdesk

Proofdesk keeps the customer's definition of "fixed" attached to the ticket, so people and agents
can do the work while the customer decides whether it is resolved.

## Try it

**The demo: <https://support-desk-demo.fly.dev>.** No account needed. The welcome page lets you
look around as one of three made-up people. The tickets are sample data, shared with everyone
who visits, so do not type anything private.

| View as              | Can                                                                                                                                                                                   | Cannot                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Demo Customer**    | File a ticket. Read, edit and reply on the tickets the Demo Customer filed (every visitor shares this one customer). Answer "Did this fix it?" on them.                               | See the team's internal notes, change a status, archive or delete.              |
| **Demo Team Member** | See every ticket. Take one and become its owner, move it to In Progress, reply, write internal notes, agree a tighter check, link the code change, attach evidence, ask the customer. | Resolve a ticket (only the customer can), archive, restore or delete.           |
| **Demo Admin**       | See everything, archived tickets included.                                                                                                                                            | Change anything: the demo admin is read-only, so no visitor can empty the demo. |

To switch person, use **Sign out** in the header and pick another.

**The real site: <https://proofdesk.fly.dev>**, with GitHub sign-in. Everyone who signs in is a
customer, except the GitHub accounts the owner has named as team members or admins.

## One ticket, from the customer's check to their Yes

1. **The customer says what "fixed" means.** As Demo Customer, choose **New ticket**. Describe
   the problem, and fill in **How will we know it's fixed?**, for example "A ten-page PDF prints
   without a jam". The ticket is New, with no owner, waiting on the team.
2. **The team does the work and shows it.** As Demo Team Member, open the ticket. **Take this
   ticket**, move it to **In Progress**, paste the **Link to the code change**, and under
   **Evidence** choose **Attach evidence** to say what you checked. Then **Ask the customer**, with
   the page on the live site to try. Nothing the team does resolves the ticket.
3. **The customer decides.** As Demo Customer, open the ticket. **Did this fix it?** shows their
   own check, the team's agreed version and the evidence. **No** needs a few words: the ticket goes
   back to its owner with those words shown first, and the team asks again when it is fixed.
   **Yes** resolves it, and only then does the ticket show the tick: "The customer confirmed it
   is fixed."

## Connect your own AI assistant

Proofdesk makes no AI calls of its own. A person's own assistant can work on tickets through an
MCP endpoint, with only the permissions its connection allows. On the demo, choose **Get a demo
connection** on the welcome page: you get your own key for a day, and the command to paste.
For Claude Code it looks like this:

```bash
claude mcp add --transport http proofdesk https://support-desk-demo.fly.dev/mcp --header "Authorization: Bearer <your key>"
```

Your assistant sees only the sample tickets and what it writes itself, never what other visitors
write. It can read a ticket (which starts with the customer's check, as `done_when`), attach
evidence, and ask the owner to request the customer's check; it can never answer for the
customer or resolve. On the real site an admin issues connections on the **Connections** page.
[`docs/AGENTS_GUIDE.md`](docs/AGENTS_GUIDE.md) has the setup for Claude Code and Claude Desktop,
the tools, the limits and a worked example.

## Run it yourself

Check `node -v` first: Node 22.14 or newer (`.nvmrc` says 22). Older versions are refused by
`npm ci`, because a dependency needs it.

**Development**, with four made-up people and no keys:

```bash
npm ci
```

```bash
cp .env.example .env
```

```bash
npm run dev
```

Open <http://localhost:3000> and pick a person. `.env.example` turns on the development entrance
(`DEV_SIGN_IN=on`); `npm run dev` reads `.env` and keeps running until you stop it.

**The demo, locally**, on its own database:

```bash
DEV_SIGN_IN=off DEMO=on DATABASE_PATH=./data/demo.db npm run dev
```

**A production build** reads only real environment variables, never `.env`:

```bash
npm run build
```

```bash
NODE_ENV=production DEMO=on DATABASE_PATH=./data/demo.db npm start
```

For the real thing, replace `DEMO=on` with the four GitHub settings below.

**Docker.** Without keys, a container can only run as the demo. Give the demo its own volume: a
database records for good whether it is for the demo or for real tickets.

```bash
docker build -t proofdesk .
```

```bash
docker run --rm -p 3000:3000 -e DEMO=on -v proofdesk-demo:/data proofdesk
```

A real run needs the four GitHub settings, with `-e` or `--env-file`, and a different volume.

### Settings

All of them are in `.env.example`, with comments.

| Name                                                                                | What it does                                                                                                   |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                          | `development`, `test` or `production`. Production refuses the development entrance and requires https sign-in. |
| `PORT`                                                                              | Default 3000.                                                                                                  |
| `DATABASE_PATH`                                                                     | The SQLite file. Default `./data/app.db`.                                                                      |
| `TICKET_PREFIX`                                                                     | The letters before a ticket's number, default `SUP`. Fixed when the database is created.                       |
| `DEV_SIGN_IN`                                                                       | `on` offers four made-up people. Development only.                                                             |
| `DEMO`                                                                              | `on` makes this server the demo: sample data, three demo people, no GitHub sign-in.                            |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in. All four or none. Required in production unless `DEMO=on`.                                     |
| `TEAM_GITHUB_IDS`, `ADMIN_GITHUB_IDS`                                               | GitHub user numbers, separated by commas. Everyone else is a customer.                                         |
| `CLIENT_IP_HEADER`                                                                  | Behind a proxy, the header with the visitor's address, for rate limits. Fly.io: `fly-client-ip`.               |
| `GIT_COMMIT`                                                                        | Reported by `GET /api/health`.                                                                                 |

### GitHub sign-in

1. On GitHub, **Settings → Developer settings → OAuth Apps → New OAuth App**. Homepage URL: your
   address, for example `http://localhost:3000`. Authorization callback URL: the same address
   followed by `/api/auth/callback/github`.
2. Put its client id and a new client secret in `.env`, with `BETTER_AUTH_URL` set to the same
   address and `BETTER_AUTH_SECRET` set to the output of `openssl rand -base64 32`.
3. Set `DEV_SIGN_IN=off`. To make yourself an admin, put your GitHub user number (the `id` at
   `https://api.github.com/users/<your user name>`) in `ADMIN_GITHUB_IDS`.

## How it is built

An Express server in TypeScript (strict) with a SQLite database through `better-sqlite3`, pages
rendered on the server with EJS and the Pico CSS stylesheet, and GitHub sign-in through Better
Auth. Inputs are checked with zod.

- **Three layers.** Routes only read the request and call the service. The service holds the
  rules and the transactions. The repository holds all the SQL.
- **One permission function**, `can()` in `src/server/permissions.ts`, decides who may do what,
  for people and for agents, whatever the door (a page, the JSON API or an agent tool). Its
  table, `CAPABILITIES`, says for each action which people may take it and which agent scope it
  needs, or that it is for people only.
- **Three statuses**: New, In Progress and Resolved. Only the customer's Yes resolves. Every
  ticket in progress has a named person who owns it, never an agent.
- **History is add-only.** Every change writes a history entry in the same transaction, saying
  who did it and whether they were a person or an agent. Database triggers refuse to change it.
- **Agents are connections**, with keys stored only as a hash. The JSON API and the MCP endpoint
  (built with the official MCP TypeScript SDK) call the same service functions as the pages.

## How it is verified

| Command                | What it runs                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`             | Every unit and route test with vitest: 666 when this was written.                                                                                                               |
| `npm run test:browser` | One real-browser journey with Playwright: a customer files, the team works it, No then Yes, and a second customer is refused. Run `npx playwright install chromium` once first. |
| `npm run typecheck`    | TypeScript, strict.                                                                                                                                                             |
| `npm run lint`         | ESLint.                                                                                                                                                                         |
| `npm run format:check` | Prettier, without changing files. `npm run format` rewrites them.                                                                                                               |

CI runs all of them on every pull request. Many changes were also broken on purpose to see their
test fail; each pull request says which.

## How the work was directed

An AI coding assistant wrote the implementation. The owner defined the behaviour, broke the work
into small changes and directed the checking, including outside reviews of the design and the
code. The specification ([`docs/SPEC.md`](docs/SPEC.md)), the history of every step
([`BUILD_LOG.md`](BUILD_LOG.md)) and the checks are in the repository.

## Known limits

- **Last writer wins** for edits to a ticket and to the agreed check. Only the customer's answer
  carries a version check, so an old page cannot answer a newer question.
- **Any team member** can take a ticket over from another, and move it between New and In
  Progress.
- **Evidence is reported, not verified.** Proofdesk shows who reported it and checks none of it.
- **No email.** Nobody is told when something changes; people look at the ticket.
- **The development cookie is unsigned.** It is safe only because production refuses the
  development entrance.
- **One machine.** SQLite on one disk; rate-limit counts are in memory and reset on a restart.
- **`ops/prove` is not a sandbox.** It runs the candidate code on the machine with only the
  environment cleaned, and its check for skipped or focused tests is a text match.
- **Permanent deletion** does not reach backups, the host's snapshots of the disk until they
  expire, or anything already sent elsewhere.
- **Demo visitors share identities.** Everyone who views as Demo Customer is the same customer.

---

## Reference

### JSON API

Every route is under `/api` and speaks JSON. The routes are built from one table, `ACTIONS` in
`src/server/api/actions.ts`, and a test checks this list against it. `GET /api` is a guide for
agents, and `GET /api/openapi.json` the full description, generated from the same table.

| Route                                         | What it does                                                                                                                                                                                                | Body                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/tickets`                            | Lists tickets in the same order as the page: open ones newest first, then resolved ones. `?status=new`, `in_progress`, `resolved`, `all` or `archived`; 100 a page, the next page named in a `Link` header. |                                                                      |
| `POST /api/tickets`                           | Files a ticket. Returns 201.                                                                                                                                                                                | `{ "title", "description", "where_url"?, "fix_check"? }`             |
| `GET /api/tickets/:key`                       | One ticket, starting with `done_when` (the checks) and `waiting_on`.                                                                                                                                        |                                                                      |
| `PATCH /api/tickets/:key`                     | Starts work: moves a New ticket you own to `in_progress`. Nothing else.                                                                                                                                     | `{ "status": "in_progress" }`                                        |
| `PUT /api/tickets/:key`                       | Replaces the ticket's text.                                                                                                                                                                                 | Same as filing.                                                      |
| `PUT /api/tickets/:key/agreed-check`          | Sets the team's agreed version of the check. Empty removes it.                                                                                                                                              | `{ "agreed_check": "..." }`                                          |
| `PUT /api/tickets/:key/change-link`           | Links the code change.                                                                                                                                                                                      | `{ "change_url": "https://..." }`                                    |
| `POST /api/tickets/:key/ready`                | The owner asks the customer "Did this fix it?", saying what they tried and what happened. Needs In Progress and a change link; after a No, `response` too.                                                  | `{ "try_url", "tried", "result", "response"?, "evidence_ids"? }`     |
| `POST /api/tickets/:key/answer`               | The customer's answer. Yes resolves; No needs a comment.                                                                                                                                                    | `{ "fixed": "yes" or "no", "ready_token": "...", "comment"? }`       |
| `POST /api/tickets/:key/take-and-start`       | Takes an unowned New ticket and starts work on it, in one step.                                                                                                                                             |                                                                      |
| `POST /api/tickets/:key/reopen`               | The customer who filed a resolved ticket says it is still happening. It goes back to its owner.                                                                                                             | `{ "reason": "..." }`                                                |
| `POST /api/tickets/:key/take`                 | Makes you the owner.                                                                                                                                                                                        |                                                                      |
| `POST /api/tickets/:key/release`              | Leaves it without an owner. Not while In Progress.                                                                                                                                                          |                                                                      |
| `POST /api/tickets/:key/archive`              | Hides it from the lists. Nothing is deleted.                                                                                                                                                                |                                                                      |
| `POST /api/tickets/:key/restore`              | Brings an archived ticket back.                                                                                                                                                                             |                                                                      |
| `DELETE /api/tickets/:key`                    | Deletes it permanently. Admin only.                                                                                                                                                                         | `{ "confirm": "SUP-42" }`                                            |
| `GET /api/tickets/:key/entries`               | The conversation. A customer never sees internal notes.                                                                                                                                                     |                                                                      |
| `POST /api/tickets/:key/entries`              | A reply, or an internal note for the team.                                                                                                                                                                  | `{ "kind": "reply" or "note", "body": "..." }`                       |
| `GET /api/tickets/:key/evidence`              | The evidence, as reported.                                                                                                                                                                                  |                                                                      |
| `POST /api/tickets/:key/evidence`             | Attaches evidence. Never resolves.                                                                                                                                                                          | `{ "kind", "summary", "link"?, "revision"?, "command"?, "result"? }` |
| `POST /api/tickets/:key/spec`                 | An agent proposes a test spec; a person decides.                                                                                                                                                            | `{ "summary", "scenarios" }`                                         |
| `POST /api/tickets/:key/spec/decision`        | A person accepts or declines the proposed spec.                                                                                                                                                             | `{ "decision": "accept" or "discard" }`                              |
| `POST /api/tickets/:key/verification-request` | Asks the owner to request the customer's check, as an internal note.                                                                                                                                        | `{ "message": "..." }`                                               |
| `GET /api/tickets/:key/events`                | The history: who did what, and whether a person or an agent.                                                                                                                                                |                                                                      |
| `GET /api/health`                             | Server and database state.                                                                                                                                                                                  |                                                                      |

`ready_token` comes from the ticket once the team has asked; it makes sure the customer answers
the question they were shown. Errors look like
`{ "error": { "code", "message", "hint", "retry" } }`: the hint says what to do next. A write
sent with an `Idempotency-Key` header is done once, however often it is retried.

With the development entrance on, the API can be tried with `curl` and a cookie. The people are
`dev-customer-1`, `dev-customer-2`, `dev-team-1` and `dev-admin-1`:

```bash
curl -c jar -H "Origin: http://localhost:3000" -d id=dev-customer-1 http://localhost:3000/sign-in/dev
```

```bash
curl -b jar -H "Origin: http://localhost:3000" -H "Content-Type: application/json" -d '{"title":"Printer jams","description":"On page two","fix_check":"Ten pages print"}' http://localhost:3000/api/tickets
```

```bash
curl -b jar http://localhost:3000/api/tickets
```

### Security

Each item has a test that fails if it is removed (`tests/security.test.ts` unless another is
named).

- Every SQL statement is a fixed string with bound values.
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

Two Fly.io apps, both described in [`docs/DEPLOY.md`](docs/DEPLOY.md): `support-desk-demo`
(`fly.toml`, the demo) and `proofdesk` (`fly.proofdesk.toml`, the real site). Each runs one
machine with its own disk. The **Deploy** workflow runs only when started by hand. On the demo,
assistant connections appear once its database has been reset since they were added: delete
the database file and restart.

### Layout

- `src/server/app.ts` builds the app; `src/server/index.ts` starts it; `src/server/start.ts`
  opens and migrates the database, refusing one labelled for the other purpose first.
- `src/server/routes/` holds the thin routes: `pages.ts` for the pages, `tickets.ts` for the JSON
  API, `connections.ts`, `sign-in.ts`.
- `src/server/tickets/` holds the ticket service, its repository and schemas.
- `src/server/permissions.ts` holds `can()` and the capability table.
- `src/server/mcp.ts` is the MCP endpoint; `src/server/connections/` the agent connections.
- `views/` holds the page templates; `public/theme.css` every colour and font.
- `migrations/` holds numbered SQL files; `tests/` the tests; `ops/prove/` the patch checker.

### History

How each step was asked for, what came back and what was found is in [`BUILD_LOG.md`](BUILD_LOG.md).
What was decided, and when it changed, is in [`docs/SPEC.md`](docs/SPEC.md).
