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
cp .env.example .env   # optional; the variables are read from the environment
npm run dev            # watch mode on http://localhost:3000
npm run build && npm start
```

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

Creating a ticket needs `title` (3 to 120 characters) and `description` (1 to 5000). It also
accepts `where_url` (an http or https URL, at most 500 characters) and `fix_check` (at most 500).

```sh
curl -X POST http://localhost:3000/api/tickets \
  -H "Content-Type: application/json" \
  -d '{"title": "Printer is broken", "description": "It jams on every page."}'
```

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
- `src/server/actor.ts` decides who is acting on a request (always anonymous for now).
- `src/server/tickets/` holds ticket keys, zod schemas, the repository (all SQL) and the service
  (rules and transactions). The service checks its own input, so every caller gets the same rules.
- The event log is append-only: database triggers refuse any update or delete of an event.
- `migrations/` holds numbered `.sql` files.
- `tests/` holds the vitest tests.
