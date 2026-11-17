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

None yet.
