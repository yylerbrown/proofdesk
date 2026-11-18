# Security and data

## Security

Each item has a test that fails if it is removed (`tests/security.test.ts` unless another is
named).

- Every SQL statement is a fixed string with bound values, except one in demo seeding that names
  its table from a fixed list in the code, never from input.
- Templates escape ticket text; links are limited to http and https.
- `helmet` sets the security headers; the content security policy allows scripts and styles
  only from this server, and no page has an inline script or style.
- A write must come from a page on this site (`src/server/same-origin.ts`), or carry an agent's
  connection key, which a browser never adds by itself.
- Sessions are kept by the sign-in library in the database and end seven days after sign-in.
  GitHub's tokens are used once during sign-in and never stored (`tests/github-callback.test.ts`).
  Account linking is off, and production requires https.
- Rate limits: 20 new tickets per ten minutes per person, 10 sign-in starts a minute per
  address, and 120 writes per ten minutes across pages, API and tools, per person or connection
  (per address on the demo). The demo also has a hard row budget.
- Answers to signed-in people are never cached. A request body over 100 KB is refused.
- The permission rules are tested on the real routes (`tests/roles.test.ts`,
  `tests/capabilities.test.ts`, `tests/connections.test.ts`).

What sign-in asks GitHub for, and how roles are given, is in the README under
[Sign-in and roles](../README.md#sign-in-and-roles).

## Permanent deletion

An admin opens a ticket, follows "Delete permanently" and types its key. In one transaction the
ticket and every row that belongs to it are removed; only its number, the time and who deleted it
are kept, and the number is never given to a new ticket. The deleted text is also wiped from the
database files, and a test searches the raw files for it. Every table whose rows belong to a
ticket carries a `ticket_id` column, and a test fails if one is missing from the deletion.

Permanent deletion does not reach backups, the host's snapshots of the disk until they expire, or
anything already sent elsewhere.
