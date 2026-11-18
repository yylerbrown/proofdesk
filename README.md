# Support Desk

Support Desk will be a customer support ticketing system. This repository holds only the
project skeleton plus the tickets core: an Express server written in TypeScript, a SQLite
database with a small migration runner, a JSON API and pages to submit tickets, list them
and change their status, tests, a Dockerfile and a CI workflow. There is no sign-in yet.

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

| Role        | What they can do                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Customer    | File tickets. See, edit, archive and reply on only their own. Cannot change a status or see internal notes. |
| Team member | See, edit, archive and change the status of every ticket. See and restore archived tickets.                 |
| Admin       | Everything a team member can. Permanent deletion, when it is built, will be for an admin only.              |

One function, `can()` in `src/server/permissions.ts`, answers every permission question, and
the ticket service asks it on every call. A ticket someone may not see answers 404, the same
as a ticket that does not exist. Who is acting comes only from the sign-in cookie, never from
a field of the request.

## Pages

The pages are HTML built on the server from the templates in `views/`. They call the same
ticket service as the JSON API. Open `http://localhost:3000/` in a browser.

| Address                     | What it shows or does                                         |
| --------------------------- | ------------------------------------------------------------- |
| `GET /tickets?status=`      | The ticket list, newest first, with the status filter.        |
| `GET /tickets/new`          | The form to file a ticket.                                    |
| `POST /tickets`             | Files the ticket from the form, then shows its page.          |
| `GET /tickets/:key`         | One ticket with its status control and its history.           |
| `POST /tickets/:key/status` | Changes the status from the ticket page, then shows it again. |

The ticket page also has an edit form (`/tickets/:key/edit`) and buttons to archive and restore.

## API

All routes are under `/api` and speak JSON. Errors look like
`{ "error": { "code": "...", "message": "..." } }`. A ticket is addressed by its public key,
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

| Method and path                  | What it does                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `PUT /api/tickets/:key`          | Replaces the title, description, link and check. Same rules as create.       |
| `POST /api/tickets/:key/archive` | Archives the ticket. Nothing is deleted.                                     |
| `POST /api/tickets/:key/restore` | Brings an archived ticket back.                                              |
| `GET /api/tickets/:key/entries`  | The conversation, oldest first. Internal notes only for the team.            |
| `POST /api/tickets/:key/entries` | Adds `{ "kind": "reply" or "note", "body": "..." }`. Notes are team only.    |
| `DELETE /api/tickets/:key`       | Deletes the ticket permanently. Admin only. Body: `{ "confirm": "SUP-42" }`. |

An archived ticket is left out of every list except `GET /api/tickets?status=archived`, and it
cannot be edited or change status until it is restored (409 `ticket_archived`). A team member
or admin can see an archived ticket and restore it. For a customer it answers 404. Archiving
from a page asks first, on a page that says what will happen.

Creating a ticket needs `title` (3 to 120 characters) and `description` (1 to 5000). It also
accepts `where_url` (an http or https URL, at most 500 characters) and `fix_check` (at most 500).

The ticket routes need a signed-in browser session, so they are not meant to be called with
`curl`. A request that changes something must also say it comes from this site, which a
browser does by itself (see Security).

## Permanent deletion

For a ticket that holds something that must be gone. An admin opens the ticket, follows
"Delete this ticket permanently" and types the key. In one transaction the ticket and every row
that belongs to it are removed, and `deleted_tickets` keeps the number, the time and who did it.

- The numbers of other tickets never change, and a deleted number is never given to a new
  ticket: the tickets table uses SQLite's `AUTOINCREMENT`.
- Asking for a deleted key answers 410 "deleted" to the team and the usual 404 to a customer.
- The event log stays append-only. Its trigger lets the events of a ticket be removed only
  once that ticket is listed in `deleted_tickets`, and that list can never be changed.
- Deleted text leaves the files on disk at once: `secure_delete` zeroes it, and a checkpoint
  empties the write-ahead log. A test searches the raw files for it.
- Every table whose rows belong to a ticket carries a `ticket_id` column and is listed in
  `TICKET_TABLES` in `src/server/tickets/repository.ts`. A test fails if a table with a
  `ticket_id` column is missing from that list.
- Deleting does not reach backups or anything already sent elsewhere.

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
  minutes and one address to 10 sign-in starts a minute. The sign-in library limits its own
  routes in production. The counts are kept in memory, so they reset when the server restarts.

- **One person, one GitHub account.** The sign-in library's account linking is off, so a
  second GitHub account showing the same email address cannot take over a person or their role.
- **https in production.** The server refuses to start in production unless `BETTER_AUTH_URL`
  starts with `https://`, so the session cookie is always marked Secure there.

Not in place yet, and part of the deploy step: behind a host's proxy the server does not know the
visitor's real address until Express's `trust proxy` and the sign-in library's
`advanced.ipAddress` setting are made. Until then both rate limiters count everyone behind the
proxy as one address.

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
