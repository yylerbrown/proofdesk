# Support desk: specification

This document was written before the features were built. Later cuts and changes are recorded at the end, not edited in silently.

## One line

A customer support desk where the customer says how they will know it is fixed, and that check is carried from the ticket through the work, whether a person or an AI agent does it, to the customer's own confirmation at the end.

## Standing rules

- A code change is linked to a ticket by pasting its link, which works with every Git host. Nothing in the desk is specific to one host except the agent run, and the README says so.
- A person reads every change before it merges.
- Nothing is ever attributed to an AI agent that an AI agent did not do.

## Who uses it

- **Customer:** files tickets and follows their own.
- **Team member:** answers tickets and fixes code. One role.
- **Admin:** a team member named in configuration.
- **AI agent:** a worker that is not a person. It takes approved work orders and proposes changes.

## The customer's side

- Sign in and file a ticket: a title, a description, and two optional fields, "Where did this happen?" (a link) and "How will we know it's fixed?" (plain words).
- Status is one of New, In Progress, Resolved, with a filter on the list.
- The customer sees only their own tickets and the public replies on them.
- At the end the customer sees their own check quoted back with "Did this fix it?" Yes resolves the ticket. No reopens it with their comment, and it goes back to its human owner.

## The team's side

- The full list with the status filter.
- Tickets carry a lettered key, such as SUP-42.
- A thread on each ticket with two kinds of entry: public replies and internal notes. The server decides who sees what.
- Tickets start unassigned. A team member takes or reassigns one. Every ticket in progress has a named human owner, including when an agent is doing the work.
- A team member may tighten the customer's check. The customer's original words are kept beside the agreed version.
- A timeline on each ticket, from one append-only record written in the same transaction as each change.

## From merged to confirmed

- A team member pastes the change link on the ticket. A link is evidence, not proof that the ticket is fixed.
- After the change is merged and deployed, a team member checks the live site, records the link to try, and marks the ticket ready for the customer. Only then is the customer asked "Did this fix it?"
- A status control must not bypass the customer's confirmation.

## Getting in

- GitHub sign-in through a standard library. A new sign-in is a customer. Team members and the admin are named in configuration.
- A labelled demo entrance: view as customer, team member or admin, on a separate sample database, enforced by the server. The admin view is read-only there, and AI calls and agent runs are off.
- Running locally with no keys needs an explicit development setting. In production, missing sign-in settings stop the server from starting.

## Permissions

- One function answers every permission question: who is acting, in which role, on whose ticket, on a public or internal entry.
- Tests exercise real routes: a customer cannot read another customer's ticket or any internal note, and request fields cannot change who is acting.

## Limits on a public site

- Sign-in or the demo entrance is required to file a ticket. Input sizes are bounded. Ticket text is always shown as text, never as markup.

## Stack

- TypeScript, Node, Express, SQLite. Pages rendered on the server with small pieces of TypeScript in the browser and a ready-made stylesheet. vitest, Docker, GitHub Actions. One always-on host with a disk.
- Standard libraries are used for sign-in, validation, database access and styling. Nothing of that kind is hand-written.

## AI features, added after the core works

1. **Sorting.** Each new ticket is saved first, then sorted in the background into a category and an urgency, each with a one-line reason, marked as AI suggestions a team member can change. If the AI is unavailable the ticket still files and shows "not sorted".
2. **The work order and the agent run.** A team member writes a short work order with a definition of done and approves it. Changing an approved work order needs approval again. The agent receives the work order only, never the customer's raw words. The run is started by hand and has three stages, each on a fresh machine:
   - **Edit.** An off-the-shelf coding agent, pinned to one version, with tools to read and edit files only and caps on turns, time and dollars. It holds nothing that can push code.
   - **Prove.** Plain commands with no secrets. The change may touch only the files the work order names. The existing tests pass on the old code, the new test fails on the old code for the expected reason, and the new test and everything else pass with the change.
   - **Open.** Plain commands on a clean machine apply the proven change and open it for review. This stage never runs code from the change.

   A team member pastes the change link and the run link onto the ticket. A person reviews and merges.

## Left out on purpose

Other sign-in providers, screens for managing people and keys, AI-drafted replies, automatic agent start, automatic discovery of linked changes, a preview copy of the app per branch, text search, email.

## Build order

1. Ticket core: file, list with the status filter, change status, history.
2. Pages for the ticket core, live on the real address.
3. Sign-in, roles enforced on the server, the demo entrance.
4. Replies, internal notes, a named human owner, the customer's check.
5. Change links, the deployment check, the customer's confirmation.
6. AI sorting.
7. The work order and the agent run.
8. Checks, README and a short recording.

## The gate before this is shown to anyone

A stranger can get in, file a ticket, filter the list, change a status and follow the worked example. Permissions hold on real routes. A clean copy runs as the README says. The data survives a restart.

## Changes since this was written

### 2026-11-17

Decided by the owner after the ticket core and its pages were built. Two points were chosen by the assistant under the owner's general go-ahead and are his to overturn: that only an admin may delete permanently, and that going live moves after sign-in.

- **Tickets are editable.** The title, the description, the "Where did this happen?" link and the "How will we know it's fixed?" check can be changed, not only the status. Every edit writes a history entry with what changed, from what, to what, in the same transaction. A customer edits their own ticket and a team member edits any. The customer's original wording of their check is still kept beside a tightened version.
- **Archiving.** An archived ticket leaves every list and is not reachable by its key for ordinary users. Its row and its history stay, and an admin can restore it. Archive and restore each write a history entry.
- **Permanent deletion.** For a ticket that holds something sensitive. An admin deletes it after typing its key. In one transaction, every row that carries the ticket's id is removed from every table that has one, and the ticket's own row is emptied and kept as a marker: the key, when it was deleted and by whom, with no content. The key is never used again, and asking for it answers "deleted", not "not found". Any table that holds ticket content must carry the ticket id, and a test fails if such a table is not covered by the deletion. Deleting does not reach backups or anything already sent elsewhere, and the README says so.
- **The history is add-only in the database.** Triggers refuse any update of a history entry, and any delete except the one made by a permanent deletion. This replaces "append-only" as a convention with a rule the database enforces.
- **The kind of actor is recorded** on every history entry, person or agent, so the standing rule about attribution can be checked from the data.
- **The key prefix is fixed when the database is first created.** The server refuses to start with a different one.
- **A security step before the site is shown to anyone,** with one test per protection that fails if the protection is removed: values always bound in SQL; ticket text shown as text on every page and links limited to http and https; security headers from a standard library, including a policy that blocks inline scripts; a defence against forged cross-site requests on every state-changing form and route once sign-in exists; fields a user must not control ignored or refused; a limit on the total size of a request; rate limits on filing tickets and on signing in; error pages that show nothing internal.

The build order becomes:

1. Ticket core: file, list with the status filter, change status, history. Then the fixes from its review.
2. Pages for the ticket core.
3. Edit and archive.
4. Security, the parts that do not need sign-in: headers, the request size limit, fields a user must not control, wider escaping tests.
5. Sign-in, roles enforced on the server, the demo entrance. With it: the defence against forged requests, rate limits, who may edit, restore by an admin, and permanent deletion.
6. Live on the real address. Moved after sign-in so that nothing is reachable before permissions hold.
7. Replies, internal notes, a named human owner, the customer's check.
8. Change links, the deployment check, the customer's confirmation.
9. AI sorting.
10. The work order and the agent run.
11. Checks, README and a short recording.
