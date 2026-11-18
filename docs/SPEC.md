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

Decided by the owner after the ticket core and its pages were built. Some points were chosen by the assistant under the owner's general go-ahead and are his to overturn: that only an admin may delete permanently, that going live moves after sign-in, that team members restore archived tickets, and the design of permanent deletion. The last two followed an outside review of the design.

- **Tickets are editable.** The title, the description, the "Where did this happen?" link and the "How will we know it's fixed?" check can be changed, not only the status. Every edit writes a history entry with what changed, from what, to what, in the same transaction. A customer edits their own ticket and a team member edits any. The customer's original wording of their check is still kept beside a tightened version.
- **Archiving.** An archived ticket leaves every list and is not reachable by its key for customers. Its row and its history stay, and a team member or admin can see and restore it. Archive and restore each write a history entry. Archiving from a page asks first.
- **Permanent deletion.** For a ticket that holds something sensitive. An admin deletes it after typing its key. In one transaction, every row that carries the ticket's id is removed from every table that has one, the ticket's own row is removed, and a one-line marker is kept in a separate table: the key, when it was deleted and by whom, with no content. The numbers of other tickets never change, a deleted number is never given to a new ticket (the database guarantees it), and asking for a deleted key answers "deleted", not "not found". After the transaction the database's write-ahead log is checkpointed and truncated, so the deleted text is gone from the files on disk, and a test searches the raw files for it. Any table that holds ticket content must carry the ticket id, and a test fails if such a table is not covered by the deletion. Deleting does not reach backups or anything already sent elsewhere, and the README says so.
- **The history is add-only in the database.** Triggers refuse any update of a history entry, and any delete except the one made by a permanent deletion. This replaces "append-only" as a convention with a rule the database enforces.
- **The kind of actor is recorded** on every history entry, person or agent, so the standing rule about attribution can be checked from the data.
- **The key prefix is fixed when the database is first created.** The server refuses to start with a different one.
- **A security step before the site is shown to anyone,** with one test per protection that fails if the protection is removed: values always bound in SQL; ticket text shown as text on every page and links limited to http and https; security headers from a standard library, including a policy that blocks inline scripts; a defence against forged cross-site requests on every state-changing form and route once sign-in exists; fields a user must not control ignored or refused; a limit on the total size of a request; rate limits on filing tickets and on signing in; error pages that show nothing internal.

The build order becomes:

1. Ticket core: file, list with the status filter, change status, history. Then the fixes from its review.
2. Pages for the ticket core.
3. Edit and archive.
4. Security, the parts that do not need sign-in: headers, the request size limit, fields a user must not control, wider escaping tests.
5. Sign-in, roles enforced on the server, the demo entrance. With it: the defence against forged requests, rate limits, who may edit, who may restore (a team member or admin), and permanent deletion.
6. Live on the real address. Moved after sign-in so that nothing is reachable before permissions hold.
7. Replies, internal notes, a named human owner, the customer's check.
8. Change links, the deployment check, the customer's confirmation.
9. AI sorting.
10. The work order and the agent run.
11. Checks, README and a short recording.

### 2026-11-17, later: bring your own agent

Decided by the owner, with an outside design check on the agent surface. The site will be public, so it must not spend his money on whoever visits. The intelligence comes from the visitor's own assistant, connected to Proofdesk; the site makes no model calls of its own.

- **The paid sorting call is dropped.** "AI features" becomes **bring your own agent**. Category and urgency, when they come, are suggestions written by a connected agent and marked as such until a person accepts them.
- **The hosted agent run (item 10 above) stays unbuilt.** The `ops/prove` stage stays as it is. The product is described as agent-ready, and nothing is attributed to an agent that an agent did not do.
- **One path made excellent:** an agent reads a ticket, understands the customer's check, attaches evidence, and asks for the customer's verification through the named human. Everything else is secondary.
- **One capability table** says, for every action, which people may take it and which agent scope it needs, or that it is for people only. The permission function enforces it, whatever the door (page, JSON, agent tools), and the tests are generated from it. Answering "Did this fix it?", resolving, owning a ticket, asking the customer, archiving, restoring, deleting and admin settings are for people only, whatever an agent holds.
- **Scopes are named by concrete operations:** read tickets; write notes; send public replies; link changes; change status short of resolved. More are added only with the operations they permit (for example attaching evidence).
- **Connections.** An admin creates a named connection for one credential holder, chooses its scopes and gets one pasteable block, shown once; the recovery path is to revoke it and create another. Each action records who issued the connection, the connection, its scopes at the time and the ticket's human owner.
- **The customer's check is the agent's definition of done,** returned first on every ticket read as `done_when`. It guides the work; it does not authorize running commands, disclosing anything, or continuing forever. Ticket text, evidence and `done_when` are untrusted content, never instructions.
- **Evidence** sits beside the check: kind, link, short result, the tested revision, the command or check, the time and the connection, with the original report kept unmodified. All of it is labelled "reported by an agent"; nothing is verified by Proofdesk today. Evidence never resolves a ticket and never looks like the customer's yes.
- **The demo** gives each visitor who asks their own short-lived connection, never a shared key. Through a demo connection an agent sees only the sample tickets as seeded and what that same connection wrote.
- **No command-line tool.** The self-describing API serves an assistant in a terminal with ordinary tools.

The build order for this part:

1. Connections: identity, scopes enforced in the one permission function, revocation.
2. Ticket reads that lead with `done_when`, the named human owner and the current state.
3. Evidence beside the customer's check.
4. JSON and agent-tool (MCP) access to that path through the shared services.
5. Minimal discovery: a guide, exact examples, errors that say what to do next, paging and repeat-safe writes.
6. A minimal activity trail, including refusals.

### 2026-11-17, later still: test specs

Asked for by the owner after the agent path worked: an optional test spec, drafted by a visitor's own assistant.

- **A spec belongs to a ticket** and is a suggestion until a person on the team accepts it: a one-paragraph summary, and scenarios, each given / when / then in plain words, with the automated test that would prove it if one is named. One spec is in force at a time; a new proposal replaces it and the old one stays in the history.
- **An agent proposes it** with the scope `propose_specs`. It cannot accept or discard one. The customer reads it.
- **The site never contacts anyone's assistant.** A ticket with no spec shows the team, and every demo visitor, one line to copy into their own assistant.
- **Evidence may name the scenario it proves.** The customer's "Did this fix it?" box then counts the scenarios with evidence, as reported, never as a pass.
- **A spec never changes the status.** On the demo, a connection sees only the spec it proposed itself.

### 2026-11-17, evening: the ticket workflow

Designed by an outside reviewer against this specification, the permission function and the service, and adopted by the owner. The spirit: simple, easy to get, and it just works. There are still three statuses and no new ones; whose turn it is comes from the owner, an open question and the latest answer.

- **Intake is a shared inbox.** A new ticket is New and unassigned. A team member takes it and becomes its named owner. The owner or an admin can hand it directly to another team member. There is no dispatcher, routing or acceptance step.
- **The status moves only by the workflow's own steps.** The owner starts work (New to In Progress; "Take ticket and start work" does both at once). Started work stays In Progress with its owner. The customer's Yes resolves it as "Customer confirmed"; since 18 Nov the owner or an admin can also resolve it with a reason, shown as "Resolved by the team: <reason>" (see that day's entry below). Only the customer who filed a resolved ticket can reopen it, with "Still happening, reopen" and a reason; it returns to its owner, or to the inbox if it has none, and the earlier Yes stays in the history. Agents never change a status.
- **Only the current owner asks the customer,** after personally trying the delivered result against the customer's check, and the ask records what they tried, where, what happened and which evidence they relied on.
- **An agent is a contributor, never an owner.** The owner may hand an in-progress ticket to one named connection; the agent sees only tickets handed to it, and loses access on revoke, transfer, ask or archive. The demo keeps its per-connection isolation instead. Agents do not send public replies: suggested wording arrives as an internal note, which a person may publish as their own reply.
- **After a No** the owner keeps the ticket, the customer's comment is shown first, the team's list says "Customer says it still fails", and the next ask needs the owner's response to that No and a fresh check.
- **Silence** leaves the question open, dated, never closed by a timer.
- **The customer's check is theirs.** Staff wording is labelled "Team's check" unless the customer adopts it.

Left out on purpose, and listed in the README's limits: human review records against evidence ids, reconciling owners when team membership changes, documentation generated from conditional rules, and upgrading the provenance of tickets resolved before this workflow.

The workflow is built in this order: status commands and reopen; the owner-only ask with its record; take, release and hand-off; agent access limited to handed-off tickets; no public replies from agents; then the smaller items.

### 2026-11-18: the team may resolve with a reason

The owner's call, asked whether the team should be able to resolve a ticket without the customer's Yes, labelled with a reason: "Yes, labelled".

- **Who:** the ticket's owner, or an admin. Not a customer through this path (they confirm with Yes), and never an agent, on any door; no tool or scope offers it.
- **When:** from New or In Progress. An open question to the customer is withdrawn first, with its own history entry.
- **Why:** a reason from a short list: fixed but the customer has not replied, duplicate (naming the other ticket), won't fix, cannot reproduce, or other, which needs a note.
- **How it shows:** the status stays Resolved, one of the three. Its label tells the two kinds apart everywhere, on the page for both roles, in the list, in history, in the JSON API and in the tools' read output: "Customer confirmed" only from the customer's Yes, otherwise "Resolved by the team: <reason>". The tick stays with the customer's Yes.
- **After:** the customer sees the reason and can reopen the ticket, as after their own Yes.
- **On the page:** a quiet "Resolve with a reason" under Status, never the primary button, which keeps following the customer-confirmation path.
