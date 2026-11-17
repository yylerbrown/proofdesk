# Support Desk

Support Desk will be a customer support ticketing system. This repository holds only the
project skeleton: an Express server written in TypeScript, a SQLite database with a small
migration runner, a health route, tests, a Dockerfile and a CI workflow. No product features exist yet.

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
- `src/server/errors.ts` holds the JSON error handling.
- `src/server/routes/` holds route modules.
- `migrations/` holds numbered `.sql` files.
- `tests/` holds the vitest tests.
