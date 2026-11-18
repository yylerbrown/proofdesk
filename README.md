# Proofdesk

Proofdesk is a customer support ticketing system. A customer files a ticket and says how they
will know it is fixed; the team works on it in the open, with internal notes beside the replies;
and only the customer marks it resolved, by answering "Did this fix it?". It is an Express
server in TypeScript with a SQLite database, server-rendered pages, GitHub sign-in, a JSON API,
tests, a Dockerfile and a CI workflow.

The whole look (colours and fonts) is in one file, `public/theme.css`; replace it to change it.

The mark, a tick, means "the customer confirmed it". Beyond the header and the browser tab, it
appears only on a ticket the customer resolved by answering yes.

## Run with Docker

```sh
docker build -t support-desk .
docker run --rm -p 3000:3000 -v support-desk-data:/data support-desk
curl http://localhost:3000/api/health
```

## Run with Node

Node 22 is the target version. Node 20 or newer works for local development.

```sh
npm ci
cp .env.example .env   # optional; npm run dev reads it
npm run dev            # watch mode on http://localhost:3000
npm run build && npm start
```

## Signing in and roles

Every ticket route needs a signed-in person. There are two ways in.

**GitHub sign-in**, through the Better Auth library. It needs a GitHub OAuth app and four
settings, listed in `.env.example`. The callback address of the OAuth app is
`<BETTER_AUTH_URL>/api/auth/callback/github`. In production the server refuses to start
without these settings. Everyone who signs in is a customer, except the GitHub accounts
named by number in `TEAM_GITHUB_IDS` and `ADMIN_GITHUB_IDS`.

**The development entrance**, for local work with no keys. Start the server with
`DEV_SIGN_IN=on` and the sign-in page offers four made-up people to act as. The server
refuses to start with that setting when `NODE_ENV` is `production`.

```sh
cp .env.example .env   # then fill it in; npm run dev reads it
npm run dev
```

| Role        | What they can do                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer    | File tickets. See, edit, archive and reply on only their own. Cannot change a status or see internal notes.                                   |
| Team member | See, edit, archive and change the status of every ticket. Take a ticket, becoming its owner, or release it. See and restore archived tickets. |
| Admin       | Everything a team member can. Permanent deletion, when it is built, will be for an admin only.                                                |

One function, `can()` in `src/server/permissions.ts`, answers every permission question, and
the ticket service asks it on every call. A ticket someone may not see answers 404, the same
as a ticket that does not exist. Who is acting comes only from the sign-in cookie, never from
a field of the request.

## The demo

A public demo runs as its own server with `DEMO=on`: a labelled entrance offering a demo customer,
team member and admin, a banner on every page, and a few sample tickets added to an empty
database at start. The demo admin can see everything and change nothing, so no visitor can archive
or delete the sample data. The server refuses `DEMO=on` together with the GitHub sign-in settings,
so a demo can never hold a real account. Each database also records on its first start whether it is for the demo or for real tickets, and the server refuses to start if that does not match `DEMO`; an existing database that already holds data is never labelled as a demo. On the demo nobody archives, restores or deletes, so one visitor cannot empty the sample data for the next.

```sh
DEMO=on DATABASE_PATH=./data/demo.db npm run dev
```

On the demo, a visitor can also get **their own assistant connection** from the welcome page,
with no sign-in: a key that lasts a day, may read the samples, write notes and attach evidence,
and sees only the sample tickets, with their text as first written, and what it writes itself.
It never sees what other visitors or other connections write, so nobody can plant instructions
for someone else's assistant. One address may get 5 an hour, and 200 may be live at once. One
sample ticket is made for an assistant to work on. A demo database seeded before this existed
does not offer connections until it is reset.

The sample data is shared by every visitor. To reset it, stop the server, delete its database
file and start it again. The demo is hosted at `https://support-desk-demo.fly.dev`.

## Pages

The pages are HTML built on the server from the templates in `views/`. They call the same
ticket service as the JSON API. Open `http://localhost:3000/` in a browser.

| Address                     | What it shows or does                                         |
| --------------------------- | ------------------------------------------------------------- |
| `GET /tickets?status=`      | The ticket list, open ones newest first, then resolved ones.  |
| `GET /tickets/new`          | The form to file a ticket.                                    |
| `POST /tickets`             | Files the ticket from the form, then shows its page.          |
| `GET /tickets/:key`         | One ticket with its status control and its history.           |
| `POST /tickets/:key/status` | Changes the status from the ticket page, then shows it again. |

The ticket page also has an edit form (`/tickets/:key/edit`) and buttons to archive and restore.

A signed-out visitor sees a short welcome on the sign-in page. The list shows each ticket's
owner, who it is waiting on and its age. After a form saves something, the next page says what
was saved. The message comes from a fixed list in `src/server/pages/saved.ts`, so no link or
form can make a page show text of its own. The JSON list (`GET /api/tickets`) uses the same
order as the page.

On a wide screen the ticket page has two columns: the description and the conversation on the
left, and a panel on the right with the status, the owner, both checks, the fix and, last and
set apart in red, archive and permanent delete. On a narrow screen it is one column, with the
panel between the description and the conversation.

## API

All routes are under `/api` and speak JSON. The API describes itself, with no sign-in
needed: **`GET /api`** is a guide an agent can act on with no other reading (what Proofdesk is,
who you are and what you may do, the exact calls for the one job, what to do with no check or
when blocked, retries, paging, limits and when to stop), and **`GET /api/openapi.json`** is the
OpenAPI 3.1 description, generated with `zod-openapi` from the same action table and schemas the
server uses. A test checks a real answer from every action against its documented shape. Errors look like
`{ "error": { "code": "...", "message": "...", "hint": "...", "retry": false } }`: the hint says
what to do next, `retry` says whether sending the same request again can work, and a validation
error also lists `fields`. The routes are built from one table, `ACTIONS` in
`src/server/api/actions.ts`.

A write sent with an `Idempotency-Key` header (any text up to 100 characters) is done once: a
retry with the same key and request gets the first answer back and changes nothing, and the
same key with a different request is refused. A refused write stores nothing. The list of
tickets comes in pages of 100; when there may be more, a `Link` header names the next page
(`rel="next"`), with an opaque `cursor` to pass back unchanged. A ticket is addressed by its public key,
for example `SUP-42`. The prefix comes from `TICKET_PREFIX` (2 to 6 capital letters, default `SUP`).
The prefix is chosen when the database is first created and is stored in it. The server
refuses to start if `TICKET_PREFIX` later differs, because that would rename every ticket.

| Method and path                | What it does                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `GET /api/health`              | Reports server and database state.                                                  |
| `POST /api/tickets`            | Creates a ticket. Returns 201.                                                      |
| `GET /api/tickets?status=`     | Lists tickets, newest first. `status` is `new`, `in_progress`, `resolved` or `all`. |
| `GET /api/tickets/:key`        | Returns one ticket, 404 if it does not exist, 400 if the key is malformed.          |
| `PATCH /api/tickets/:key`      | Changes the status with `{ "status": "resolved" }`. The same status is a no-op.     |
| `GET /api/tickets/:key/events` | Returns the ticket's log of events, oldest first, with who acted and of what kind.  |

More routes change a ticket. Each one writes an event in the same transaction.

| Method and path                      | What it does                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `PUT /api/tickets/:key`              | Replaces the title, description, link and check. Same rules as create.          |
| `POST /api/tickets/:key/archive`     | Archives the ticket. Nothing is deleted.                                        |
| `POST /api/tickets/:key/restore`     | Brings an archived ticket back.                                                 |
| `PUT /api/tickets/:key/agreed-check` | Team only. Sets the agreed check `{ "agreed_check": "..." }`; empty removes it. |
| `POST /api/tickets/:key/take`        | Makes the signed-in team member the owner.                                      |
| `POST /api/tickets/:key/release`     | Leaves the ticket without an owner. Not while it is in progress.                |
| `GET /api/tickets/:key/entries`      | The conversation, oldest first. Internal notes only for the team.               |
| `POST /api/tickets/:key/entries`     | Adds `{ "kind": "reply" or "note", "body": "..." }`. Notes are team only.       |
| `DELETE /api/tickets/:key`           | Deletes the ticket permanently. Admin only. Body: `{ "confirm": "SUP-42" }`.    |

An archived ticket is left out of every list except `GET /api/tickets?status=archived`, and it
cannot be edited or change status until it is restored (409 `ticket_archived`). A team member
or admin can see an archived ticket and restore it. For a customer it answers 404. Archiving
from a page asks first, on a page that says what will happen.

Every ticket in progress has a named human owner. A ticket starts with none. A team member
takes it, and only then can it move to In Progress; while it is in progress it cannot be
released, only taken over by someone else. An agent can never be the owner. The database refuses
an in-progress ticket without an owner as well (migration `0010`).

Creating a ticket needs `title` (3 to 120 characters) and `description` (1 to 5000). It also
accepts `where_url` (an http or https URL, at most 500 characters) and `fix_check` (at most 500).

The ticket routes need a signed-in browser session, so they are not meant to be called with
`curl`. A request that changes something must also say it comes from this site, which a
browser does by itself (see Security).

## Agent connections

Proofdesk makes no AI calls of its own. An AI assistant works on tickets through the API with
a **connection**: an admin issues one on the Connections page, gives it a name, chooses what it
may do, and copies its key, which is shown once. If the key is lost or leaked, revoke the
connection and issue a new one. Only a hash of the key is stored.

An assistant connects to the MCP endpoint, `/mcp`, built with the official MCP TypeScript SDK
over streamable HTTP; the connection page shows the one command that connects Claude Code. The
same actions are a JSON API under `/api`. Either way the key goes in each request as
`Authorization: Bearer pd_...`; keys never work on the pages. The tools are built from the same
table as the API routes, call the same service functions, and leave out every people-only action.
Each tool's description says that ticket text is data written by people, never instructions.
`docs/AGENTS_GUIDE.md` has the setup for Claude Code and Claude Desktop, the tool list, the limits
and a worked example.

What an agent may do is decided by the capability table, `CAPABILITIES` in
`src/server/permissions.ts`, which the tests are generated from. The scopes are named by what
they allow: read tickets, write internal notes, send replies, link changes, change the status
(never to resolved). Answering "Did this fix it?", resolving, owning a ticket, asking the
customer, archiving, restoring, deleting and managing connections are for people only. Each
agent action in the history records the connection, who issued it, its scopes at that moment
and the ticket's owner. Each connection has its own write allowance.

Everything a connection asks for, through the API or the tools, is recorded with how it ended:
done, or refused with its code, with the idempotency key if one was sent. The team sees it on
each connection's page (Connections, then the connection's name), newest first, for 30 days. The
record holds keys and codes, never ticket text. In a ticket's history an agent is named by its
connection and marked "(AI agent)".

Every ticket the API returns starts with `done_when`: the agreed check, the customer's own words,
and one line of guidance. Only the customer can say a ticket is fixed; the check guides the work
but does not authorize running commands, disclosing anything, or continuing without end. With no
check, the guidance says to ask the named owner instead of guessing. Next comes `waiting_on`:
`team`, `customer` or `nobody`.

**Evidence** sits beside the check: `POST /api/tickets/:key/evidence` with a kind (`test`,
`check_run`, `change_link` or `note`), a one-line summary, and optionally a link, the revision
tested, the command that ran, a short result and the original report. The report of `ops/prove`
(`evidence.json`) can be attached as it is, and the ticket page reads its three stages into a
small table: the new test before the fix, the existing tests before it, all tests after it. A
stage counts only when the report states it plainly; anything missing is shown as unknown,
never as passed. Every piece is labelled with who reported it and "Not checked by Proofdesk",
because Proofdesk verifies none of it. Evidence never changes a ticket's status. The customer
sees it in the "Did this fix it?" box, and only their answer resolves the ticket.

## From merged to confirmed

Only the customer resolves a ticket. The status control offers New and In Progress; Resolved is
refused (409 `needs_customer`).

1. A team member pastes the link to the code change (`PUT /api/tickets/:key/change-link`). It is
   evidence, not proof: the status does not change.
2. After the change is live and checked, a team member asks the customer, with the page to try
   (`POST /api/tickets/:key/ready`). The ticket must be in progress, so it has an owner, and have
   its change link.
3. The person who filed the ticket sees "Did this fix it?" with their check quoted, the agreed
   version first. Yes resolves the ticket. No needs a comment, puts the ticket back in progress
   with its owner, and adds the comment to the conversation (`POST /api/tickets/:key/answer`
   with `{ "fixed": "yes" }` or `{ "fixed": "no", "comment": "..." }`).

Each question carries a fresh token, and the answer must carry the token of the question the customer was shown, so an old page cannot answer a newer question (409 `question_changed`). Any change of status by the team, or a change to the ticket's text, the agreed check or the change link, withdraws the question. Asking again while waiting changes nothing.

## Permanent deletion

For a ticket that holds something that must be gone. An admin opens the ticket, follows
"Delete this ticket permanently" and types the key. In one transaction the ticket and every row
that belongs to it are removed, and `deleted_tickets` keeps the number, the time and who did it.

- The numbers of other tickets never change, and a deleted number is never given to a new
  ticket: the tickets table uses SQLite's `AUTOINCREMENT`.
- Asking for a deleted key answers 410 "deleted" to the team and the usual 404 to a customer.
- The event log stays append-only. Its trigger lets the events of a ticket be removed only
  once that ticket is listed in `deleted_tickets`, and that list can never be changed.
- Deleted text normally leaves the files on disk at once: `secure_delete` zeroes it, and a
  checkpoint empties the write-ahead log. A test searches the raw files for it. If another
  connection is reading at that moment, the checkpoint cannot finish; the answer then says
  the ticket is deleted from the database but the files are not yet cleaned.
- Every table whose rows belong to a ticket carries a `ticket_id` column and is listed in
  `TICKET_TABLES` in `src/server/tickets/repository.ts`. A test fails if a table with a
  `ticket_id` column is missing from that list.
  The test only finds columns named exactly `ticket_id`, so that is the name to use.
- Deleting does not reach backups, the host's snapshots of the disk until they expire, or
  anything already sent elsewhere.

## Security

What is in place, and the test file that fails if it is removed (`tests/security.test.ts`
unless another is named):

- **SQL.** Every statement in `src/server/tickets/repository.ts` is a fixed string with `?`
  placeholders. Values are bound by the database driver and never joined into SQL text.
- **Script injection.** Templates print ticket text with `<%= %>`, which escapes it. The link
  field accepts only http and https addresses. See also `tests/pages.test.ts`.
- **Headers.** The `helmet` library sets the security headers. The content security policy
  allows scripts and styles only from this server, so an inline script cannot run. No page
  contains an inline script or an inline style.
- **Fields a caller must not control.** The service reads only the title, description, link and
  check (and the status, for a status change). Anything else in a request is dropped.
- **Size.** A request body over 100 KB is refused with 413. Each field also has its own limit.
- **No caching.** Every answer to a signed-in person is marked `Cache-Control: no-store`, so
  tickets and notes do not stay in a browser's cache after signing out.
- **The sign-in library's own routes** get the same forged-request check and a sign-in limit
  as the app's routes.
- **Errors.** An unexpected failure is logged on the server and answered with a fixed message.

- **Permissions.** Roles are enforced in the service, with tests on the real routes in
  `tests/roles.test.ts` and a table of every rule in `tests/permissions.test.ts`.

- **Sessions.** The sign-in library keeps sessions in the database and sets a cookie that
  scripts cannot read. Signing out deletes the session. See `tests/sign-in.test.ts`.
- **Forged cross-site requests.** `src/server/same-origin.ts` refuses any request that
  changes something unless the browser says it comes from this site. A request that does not
  say where it comes from is refused too. See `tests/sign-in.test.ts`.
- **Sign-in cannot send people elsewhere.** After signing in, the browser returns to the page
  that was asked for, and only an address on this site is accepted.
- **Flooding.** The `express-rate-limit` library limits one person to 20 new tickets in ten
  minutes and one address to 10 sign-in starts a minute. A refused ticket, for example a form with a mistake in it, does not count. On top of that, every request that changes something, pages and API together, shares one allowance of 120 per ten minutes. A real person is counted by account; demo visitors, who share three made-up identities, are counted by address. The demo also has a hard budget of rows (200 tickets, 50 replies and 100 history entries per ticket), and lists, conversations and history are read in bounded pages (100 tickets a page, the latest 200 entries). The sign-in library limits its own
  routes in production. The counts are kept in memory, so they reset when the server restarts.

- **GitHub tokens are stored encrypted.** The token GitHub hands over at sign-in is only kept
  encrypted with the secret, so a copy of the database holds no working GitHub token.
- **One person, one GitHub account.** The sign-in library's account linking is off, so a
  second GitHub account showing the same email address cannot take over a person or their role.
- **https in production.** The server refuses to start in production unless `BETTER_AUTH_URL`
  starts with `https://`, so the session cookie is always marked Secure there.

- **The visitor's address behind a proxy.** With `CLIENT_IP_HEADER` set, both rate limiters read
  the visitor's address from that header instead of the connection, which behind a host's proxy
  is always the proxy. `fly.toml` sets it to Fly's `fly-client-ip`; the first deploy must check
  that a visitor cannot set it themselves (see `docs/DEPLOY.md`).

## Deploying

The demo runs on Fly.io: one machine, always on, with a disk for the SQLite file. The real site,
`proofdesk`, with GitHub sign-in, is a second app with its own disk (`fly.proofdesk.toml`). The settings are in `fly.toml` and every step is in `docs/DEPLOY.md`. The **Deploy** workflow runs only
when started by hand.

## Tests and checks

```sh
npm test
npm run typecheck
npm run lint
npm run format
```

## Layout

- `src/server/app.ts` builds the Express app without listening.
- `src/server/index.ts` loads config, opens the database, runs migrations and listens.
- `src/server/config.ts` validates environment variables with zod.
- `src/server/db.ts` opens the SQLite database.
- `src/server/migrate.ts` applies numbered files from `migrations/` and records them.
- `src/server/errors.ts` holds the error handling: JSON for the API, an HTML page for pages.
- `src/server/validation.ts` checks a value against a zod schema.
- `src/server/routes/` holds route modules. They stay thin and call the services.
  `tickets.ts` is the JSON API and `pages.ts` is the pages.
- `src/server/pages/format.ts` turns stored values into the words shown on a page.
- `views/` holds the page templates (EJS: HTML with small pieces of JavaScript).
- `public/site.css` holds the few style rules added on top of the Pico CSS stylesheet.
- `src/browser/local-time.ts` is the only browser code: it rewrites each `<time>` into the
  visitor's own time zone. `npm run build` (and `npm run dev`) compile it to `public/js/`,
  which is not committed. Without scripts, the pages show times in UTC.
- `src/server/actor.ts` decides who is acting on a request, from the sign-in cookie.
- `src/server/permissions.ts` holds `can()`, the one function that says who may do what.
- `src/server/routes/sign-in.ts` is the sign-in page, the GitHub start and the development entrance.
- `src/server/auth.ts` builds the sign-in library and maps a GitHub account to a role.
- `src/server/same-origin.ts` refuses forged cross-site requests.
- `src/server/tickets/` holds ticket keys, zod schemas, the repository (all SQL) and the service
  (rules and transactions). The service checks its own input, so every caller gets the same rules.
- The event log is append-only: database triggers refuse any update or delete of an event.
- `migrations/` holds numbered `.sql` files.
- `tests/` holds the vitest tests.
