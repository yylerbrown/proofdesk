# Production checklist

How Proofdesk compares with what a production web application needs. The yardsticks are the
[Twelve-Factor App](https://12factor.net), the
[reliability](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)
and
[performance efficiency](https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html)
pillars of the AWS Well-Architected Framework, and
[OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/).

Every line below was checked against the code on this branch or by running the server locally
with a throwaway database of 20,000 tickets. Today Proofdesk runs as one process on one machine
with one SQLite file. Most of the "not met" lines follow from that choice.

Measured numbers under load are in [Load test](#load-test) below.

| Item                                      | Today, and where                                                                                                                                                                                                                                                                                                                                                                                                      | State      | To run on several machines or at scale                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| Settings from the environment             | Every setting is read from the environment and checked with zod at start. Production refuses the development entrance, plain http and missing sign-in settings. `src/server/config.ts`                                                                                                                                                                                                                                | Met        | Nothing.                                                                                                      |
| Same setup in development and production  | One Dockerfile for both sites; SQLite and the same migrations everywhere. The two Fly files differ only in their settings.                                                                                                                                                                                                                                                                                            | Met        | Nothing.                                                                                                      |
| Processes that keep no state              | Sessions are in the database. The data is one SQLite file on one volume. Rate-limit counters live in each process's memory (`src/server/app.ts`, and the sign-in library's own).                                                                                                                                                                                                                                      | Not met    | Postgres in place of SQLite; a shared store such as Redis for rate-limit counters.                            |
| More than one machine                     | One machine, always on, by design (`fly.toml`, `fly.proofdesk.toml`).                                                                                                                                                                                                                                                                                                                                                 | Not met    | Follows from the two lines above; then two machines in two zones behind the host's proxy.                     |
| Fast start                                | Migrations run at start, then the server listens. No warm-up step. `src/server/index.ts`                                                                                                                                                                                                                                                                                                                              | Met        | Run migrations as a separate release step, so two machines never migrate at once.                             |
| Clean shutdown                            | On SIGTERM: stop listening, finish requests in flight for up to 8 seconds, close SQLite, exit 0. The host waits 10. `src/server/serve.ts`, `tests/clean-stop.test.ts`                                                                                                                                                                                                                                                 | Met        | Nothing.                                                                                                      |
| Logs                                      | One JSON line per request on standard output, with a request id; the path is logged without its query string, so sign-in codes and searches stay out. `src/server/http-basics.ts`                                                                                                                                                                                                                                     | Partly met | An unexpected error is printed as a stack trace without the request id (`src/server/errors.ts`).              |
| Health check                              | `/api/health` runs a query against the database and answers 503 when it fails. The host checks it every 30 seconds. `src/server/routes/health.ts`                                                                                                                                                                                                                                                                     | Met        | A check that also covers the shared stores once there are any.                                                |
| Timeouts on outgoing calls                | The only outgoing calls are to GitHub during sign-in. Proofdesk sets no timeout of its own; it relies on the sign-in library's and Node's defaults.                                                                                                                                                                                                                                                                   | Partly met | A short, explicit timeout on the GitHub calls, with a plain message when GitHub is slow.                      |
| Backups and a restore that has been tried | A safe backup command is in `docs/DEPLOY.md`; the host also keeps volume snapshots. Tried locally (see the notes). A restore on the host has not been tried.                                                                                                                                                                                                                                                          | Partly met | Scheduled backups copied off the machine, and a restore drill on a schedule. Postgres point-in-time recovery. |
| Indexes behind every list                 | See the notes. The team's list reads an index that matches each order it offers (migration 0032), as do the person's own list, the history, the conversation and the activity trail. The counts beside the status filters and the search still read every ticket in scope.                                                                                                                                            | Partly met | Full-text search (SQLite FTS5 or Postgres) for the search box.                                                |
| Pagination                                | 100 tickets a page, by offset; the page number is capped at 100,000. The API's cursor carries its page and order. `src/server/tickets/types.ts`, `src/server/pages/list-query.ts`                                                                                                                                                                                                                                     | Partly met | Pages by the last id seen, so a deep page costs the same as the first.                                        |
| No queries inside loops                   | Each ticket on a list costs one or two small indexed lookups of its own (its latest answer and, for the team, its hand-off). The ticket page reads only the people it names, not everyone who ever signed in.                                                                                                                                                                                                         | Partly met | Read those for the whole page in one query each.                                                              |
| Compressed answers                        | Text answers are compressed, except any answer marked no-store. `src/server/http-basics.ts`                                                                                                                                                                                                                                                                                                                           | Partly met | Every signed-in page is no-store, so the pages people use most are sent uncompressed.                         |
| Cache headers on static files             | Styles, scripts and images: 10 minutes. Fonts: one day. Signed-in pages: no-store. `src/server/app.ts`                                                                                                                                                                                                                                                                                                                | Met        | File names that carry a content hash, so they can be cached for a year.                                       |
| Core Web Vitals                           | Not measured.                                                                                                                                                                                                                                                                                                                                                                                                         | Not met    | Lighthouse runs on the welcome page, the list and a ticket.                                                   |
| Two people at once                        | One process, and every action runs in a database transaction that reads the ticket first, so two actions never interleave. Each ticket has a version: a save or a press from an old copy of the page is refused and keeps what was typed, and an open page says when the ticket changed. Tests run two actors against one ticket for each race. `src/server/tickets/checks.ts`, `tests/two-people-one-ticket.test.ts` | Met        | Nothing.                                                                                                      |
| Security (OWASP ASVS)                     | GitHub sign-in with sessions in the database that end after seven days; roles checked in one place (`src/server/permissions.ts`); zod on request input; same-origin check on every write; CSP and security headers (helmet); rate limits on filing, sign-in and writes.                                                                                                                                               | Partly met | A full walk through ASVS level 2 has not been done. The areas named here have code and tests.                 |

## Notes

**Indexes.** Each list query was run through `EXPLAIN QUERY PLAN` on a database of 20,000
tickets.

- The team's ticket list reads `tickets_list_open_first` in the default order, and stops once
  the page is full. Each column sort reads its own index, `tickets_list_title`,
  `tickets_list_status`, `tickets_list_owner`, `tickets_list_filed` or `tickets_list_updated`,
  either way; the key sort follows the table's own id order. None of them sorts the table. The
  counts beside the status filters read every ticket in scope once per list view, which exact
  counts need.
- Search uses `LIKE '%word%'` on the title and the description, so it reads every row whatever
  the indexes.
- A customer's own list uses `idx_tickets_created_by`, then sorts.
- An assistant's list reads its handed tickets by primary key.
- The archived list scans the table.
- History, conversation and evidence use their `ticket_id` indexes. The activity trail uses
  `agent_activity_connection`. The connections page scans `agent_connections`, which holds at most
  a few hundred rows.

**Queries inside loops.** Turning each ticket row into the answer calls `latestAnswer` (one
indexed query, and a second when the customer has answered) and, for the team, `activeHandoff`
(one indexed query). A team page of 100 tickets therefore makes 100 to 300 small queries. With
SQLite inside the process each is cheap; across a network to Postgres it would not be. The
assistant signals on the list are already read in one query for the whole page. Display names in
the history are looked up one person at a time, once per distinct person.

**Backup, tried locally.** With the server running and the write-ahead log holding recent
changes:

- A plain file copy of `app.db` alone passed SQLite's integrity check but was missing the last 20
  tickets, which were still only in the log. A plain copy is not a backup.
- SQLite's online backup (the `better-sqlite3` command in `docs/DEPLOY.md`, and the `sqlite3`
  shell's `.backup`) and `VACUUM INTO` each produced a copy with every ticket, including one filed a
  moment before the copy began.
- A second server started from the backup on another port applied no migrations, served the
  newest tickets, accepted a new ticket and stopped cleanly on SIGTERM.

What has not been tried is the same on the host: taking the copy off the Fly machine and
starting a machine from it, or restoring a volume snapshot.

## Load test

Measured on 18 November 2026 on a developer laptop (14 cores, Node 24) that was shared with other
work at the time, so every number is indicative only; the hosted machine's single shared CPU will
be slower. The server ran as the production build with 5,000 tickets and 1,561 people, signed in
through real session rows. It was taken before the list index and the ticket page change above.

| What                                            | Requests a second | Median  | 95th percentile          |
| ----------------------------------------------- | ----------------- | ------- | ------------------------ |
| The team's list page, 10 connections            | 142               | 70 ms   | 76 to 82 ms (p90, p97.5) |
| One ticket's page, 10 connections               | 350               | 26 ms   | 30 to 34 ms (p90, p97.5) |
| One ticket as JSON, 50 connections              | 4,693             | 9 ms    | 14 to 17 ms (p90, p97.5) |
| Filing tickets, 50 connections, past the limits | 2,906             | 15.6 ms | 24.4 ms                  |
| Replies, 50 connections, past the limits        | 2,700             | 17.5 ms | 28.7 ms                  |
| 90% reads and 10% writes, 50 connections        | 266               | 190 ms  | 275 ms                   |

The read tool gives the 90th and 97.5th percentiles, not the 95th, so both are shown. Across about
1.85 million requests no answer was a server error, and no write was lost or stored twice. Twenty
people writing to one ticket for 20 seconds left a history that adds up exactly.

Fixed since:

- **The list read and sorted the whole table.** It now reads an index for each order.
- **The ticket page read every person who ever signed in, twice.** It now reads only the people
  its history names and those who can own a ticket. At 15,061 people this cost the page about
  21 ms of its time.

Still open:

- **One event loop.** A slow page delays every other request, so the list pages set the ceiling,
  roughly 150 to 250 page views a second on that laptop.
- **Above about 120 connections**, 1 to 2% of requests waited about 10 seconds before the app
  saw them. The cause was not found. No concurrency limit is set for the host's proxy.
- **A stop under load** answers every request already started, but closes idle keep-alive
  connections, so a request sent on one at that moment gets a connection error. None of them was
  written, so a retry is safe.
- **A refused write still counts** against that person's write limit.
- **The two-person check under load** was measured before the version check existed. The
  version check is tested with two actors on one ticket for each race, not under load.
