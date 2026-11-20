# Support desk: specification

This document was drafted in a design conversation with the owner on 17 November 2026, before any code was built. It was opened as pull request #3, twenty minutes after the first slice of the ticket core (#2). Later cuts and changes are recorded at the end, not edited in silently.

## One line

A customer support desk where the customer says how they will know it is fixed, and that check is carried from the ticket through the work, whether a person or an AI agent does it, to the customer's own confirmation at the end.

## Standing rules

- A code change is linked to a ticket by pasting its link, which works with every Git host. Nothing in the desk is specific to one host except the agent run, and the README says so.
- The assistant that builds a change never merges, never pushes to `main` and never deploys. A pull request merges only when its CI checks pass.
- In this build the project skeleton, seven commits on 17 November, went straight to `main` with no pull request, and every later change came through one. Under the owner's standing instruction, a separate coordinating assistant merged pull requests whose CI checks had passed, using the owner's GitHub account, and deployed the demo and the real site. Not every merge waited for CI. Pull request #1 was merged while its restarted checks were still running, and they passed two minutes later. GitHub Actions stopped starting jobs at 17:01 UTC on 18 November, so the pull requests merged while it was stopped, starting with #96, had no CI run on their final commit. Each of them was merged only after the same checks (typecheck, lint, format, unit tests, build and the browser journey) passed locally on the exact commit being merged. The owner set the direction and priorities, made the design calls, and gave feedback on the live product as it grew. Reviews came from other AI sessions, including another vendor's models, and no human reviewer read the pull requests.
- Nothing is ever attributed to an AI agent that an AI agent did not do.

## Who uses it

- **Customer:** files tickets and follows their own.
- **Team member:** answers tickets and fixes code. One role.
- **Admin:** a team member named in configuration.
- **AI agent:** a worker that is not a person. It takes approved work orders and proposes changes.

## The customer's side

- Sign in and file a ticket: a title, a description, and two optional fields, "Where did this happen?" (a link) and "How will we know it's fixed?" (plain words). (Since 19 Nov the form asks for the title, the description and pictures, and a second step asks "What would prove it is fixed?"; the link stays in the API. See that day's entry.)
- Status is one of New, In Progress, Resolved, with a filter on the list.
- The customer sees only their own tickets and the public replies on them.
- At the end the customer sees their own check quoted back with "Did this fix it?" Yes resolves the ticket. No reopens it with their comment, and it goes back to its human owner. (Since 19 Nov the team's "Mark fixed and tell the customer" resolves the ticket and asks; the customer's Yes is optional and marks it confirmed.)

## The team's side

- The full list with the status filter.
- Tickets carry a lettered key, such as SUP-42.
- A thread on each ticket with two kinds of entry: public replies and internal notes. The server decides who sees what.
- Tickets start unassigned. A team member takes or reassigns one. Every ticket in progress has a named human owner, including when an agent is doing the work.
- A team member may tighten the customer's check. The customer's original words are kept beside the agreed version.
- A timeline on each ticket, from one append-only record written in the same transaction as each change.

## From merged to confirmed

- A team member pastes the change link on the ticket. A link is evidence, not proof that the ticket is fixed.
- After the change is merged and deployed, a team member checks the live site, records the link to try, and marks the ticket ready for the customer. Only then is the customer asked "Did this fix it?" (Since 19 Nov marking it fixed resolves it and asks in one press.)
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

Other sign-in providers (Microsoft, for one organization, came in on 19 Nov), screens for managing keys, AI-drafted replies, automatic agent start, automatic discovery of linked changes, a preview copy of the app per branch. (Text search was first left out here; it came in on 18 Nov with the owner filters. Screens for managing people and email were left out too; both came in that afternoon, see its entry below.)

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
- **Permanent deletion.** For a ticket that holds something sensitive. An admin deletes it after typing its key. In one transaction, every row that carries the ticket's id is removed from every table that has one, the ticket's own row is removed, and a one-line marker is kept in a separate table: the key, when it was deleted and by whom, with no content. The numbers of other tickets never change, a deleted number is never given to a new ticket (the database guarantees it), and asking for a deleted key answers "deleted", not "not found". After the transaction the database's write-ahead log is checkpointed and truncated, so the deleted text is gone from the files on disk, and a test searches the raw files for it. Any table that holds ticket content must carry the ticket id, and a test fails if such a table is not covered by the deletion. Deleting does not reach backups or anything already sent elsewhere, and `docs/SECURITY.md` says so.
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
- **The status moves only by the workflow's own steps.** The owner starts work (New to In Progress; "Take ticket and start work" does both at once). Started work stays In Progress with its owner. The customer's Yes resolves it as "Customer confirmed"; since 18 Nov the owner or an admin can also resolve it with a reason, shown as "Resolved by the team: <reason>" (see that day's entry below). The customer who filed a resolved ticket can reopen it, with "Still happening, reopen" and a reason, and since 18 Nov the owner or an admin can reopen a ticket the team resolved, never one the customer confirmed; it returns to its owner, or to the inbox if it has none, and the earlier Yes stays in the history. Agents never change a status.
- **Only the current owner asks the customer,** after personally trying the delivered result against the customer's check, and the ask records what they tried, where, what happened and which evidence they relied on. Since the afternoon of 18 Nov each of those details is optional, and asking is one press (see that entry below).
- **An agent is a contributor, never an owner.** The owner may hand an in-progress ticket to one named connection; the agent sees only tickets handed to it, and loses access on revoke, transfer, ask or archive. The demo keeps its per-connection isolation instead. Agents do not send public replies: suggested wording arrives as an internal note, which a person may publish as their own reply.
- **After a No** the owner keeps the ticket, the customer's comment is shown first, the team's list says "Customer says it still fails", and the next ask needed the owner's response to that No and a fresh check. Since the afternoon of 18 Nov nothing is required before asking again: the response is optional, like every other detail of the ask.
- **Silence** leaves the question open, dated, never closed by a timer.
- **The customer's check is theirs.** Staff wording is labelled "Team's check" unless the customer adopts it.

Left out on purpose: human review records against evidence ids, reconciling owners when team membership changes, documentation generated from conditional rules, and upgrading the provenance of tickets resolved before this workflow. What the product does today when an owner leaves the team is in the README's known limits; what comes next is in `docs/ROADMAP.md`.

The workflow is built in this order: status commands and reopen; the owner-only ask with its record; take, release and hand-off; agent access limited to handed-off tickets; no public replies from agents; then the smaller items.

### 2026-11-18: two corrections

Two sentences above were corrected to say what happened. The opening line used to say this document was written before the features were built, and the standing rule on merging used to say a person reads every change before it merges. The standing rules now also say how this build was merged and reviewed, including the merges that did not wait for CI. Every outside review named in this document came from other AI sessions, including the one that proposed the ticket workflow the owner adopted. That workflow's central rule, that only the customer's Yes resolves a ticket, was the owner's and was in this document from the start.

### 2026-11-18: the team may resolve with a reason

The owner's call, asked whether the team should be able to resolve a ticket without the customer's Yes, labelled with a reason: "Yes, labelled".

- **Who:** the ticket's owner, or an admin; since that afternoon, also a team member for a ticket nobody owns, who becomes its owner. Not a customer through this path (they confirm with Yes), and never an agent, on any door; no tool or scope offers it.
- **When:** from New or In Progress. An open question to the customer is withdrawn first, with its own history entry.
- **Why:** a reason from a short list: fixed but the customer has not replied, duplicate (naming the other ticket), won't fix, cannot reproduce, or other, which needs a note.
- **How it shows:** the status stays Resolved, one of the three. Its label tells the two kinds apart everywhere, on the page for both roles, in the list, in history, in the JSON API and in the tools' read output: "Customer confirmed" only from the customer's Yes, otherwise "Resolved by the team: <reason>". The tick stays with the customer's Yes.
- **After:** the customer sees the reason and can reopen the ticket, as after their own Yes. Later the same day the owner or an admin could also reopen it, with a reason, shown as "Reopened by the team: <reason>"; a ticket the customer confirmed stays theirs to reopen.
- **On the page:** a quiet "Resolve" under Status that opens the reason form, never the primary button, which keeps following the customer-confirmation path.

### 2026-11-18, afternoon: people, email and a shorter ask

The owner's decision, under his call that sign-in be polished and done properly: an admin chooses who is on the team in the product. The same afternoon, email notices went out and asking the customer became one press.

- **People.** An admin opens People from the header and chooses each signed-in person's role: customer, team member or admin. It applies on that person's next page, with no restart, and every change is kept in an add-only history of role changes. People named in `ADMIN_GITHUB_IDS` or `TEAM_GITHUB_IDS` keep that role and show as locked, so the site cannot lock itself out. An admin cannot change their own role, and a team member who still owns unresolved tickets keeps the role until those are handed on. This replaces "screens for managing people" in the list of things left out; screens for keys stay as they are, on Connections.
- **Each person's account page** shows who Proofdesk thinks they are, and has one switch, "Email me about my tickets", on by default.
- **Email.** Notices are worked out from the ticket history, written to an outbox, and sent with nodemailer once a mail server is set (`SMTP_URL` and `MAIL_FROM`). Only verified addresses are mailed, never about an internal note or an assistant's work. The demo never sends. Each ticket has a read-only page of its notices. This replaces "email" in the list of things left out.
- **A shorter ask.** After taking a ticket, one press asks the customer "Did this fix it?". The page to try, what was tried, what happened, the response to a No and evidence are optional, and the customer sees each one given. The demo's sample fix is gone.
- **Resolving an unowned ticket.** A team member may resolve a New ticket nobody owns, with a reason, and becomes its owner as part of it. The owner or an admin can reopen a ticket the team resolved, never one the customer confirmed.

### 2026-11-18, evening: the status row, two people on one ticket, and the list

Fixes and smaller calls the same evening, under the owner's call that ticketing is the focus. No new status and no new AI surface.

- **A plain status row.** The team sees New, In Progress and Resolved on the ticket page, the current one marked, each other one a single press. In Progress from New takes the ticket and starts work; Resolved opens the reason form in place and records "Resolved by the team: <reason>"; New sends an In Progress ticket back to the inbox with no owner, withdrawing an open question and ending an assistant's work. A move the viewer may not make is shown disabled with its reason. This replaces the quiet "Resolve" under Status above. The one next step at the top of the page stays.
- **Resolve reasons.** The first reason reads "Fixed, not yet confirmed". It is not offered while the customer's No or reopening stands with no question asked since.
- **Two people on one ticket.** Every ticket carries a version that rises on every change to its row. The edit and every action that changes a ticket's state accept the version the page or caller read; an older one is refused with nothing written, and the page shows the form again with the typed text kept. Archive and restore take none. An open page asks for the version when it regains focus, and at most every 30 seconds, and says "This ticket changed. Refresh to see it." without replacing anything. The version counts only what a customer may see, so it never tells a customer about team-only work.
- **The list.** A ticket key typed in the search opens that ticket when the viewer may see it. Each status shows its count, within the owner filter and search in force. An order choice under the table offers Open first (the default), Oldest first and Recently updated, kept in the address and in the API's cursor. The list reads an index for each order.
- **The assistant run page** opens with what the assistant did and that it resolved nothing; how it was run sits in one closed section. The demo's assistant samples are filed first and by a second made-up customer, so they sit under the plain samples and out of Demo Customer's list.
- **Roles.** A lowered role stops that person's email notices and ends the assistant connections they issued, and the Connections page says why a connection ended. The demo's forced reset at two days no longer waits for a request held open.

### 2026-11-18, late evening: words a reader can act on

- **The ticket page names what each control does.** The status row's third control reads "Resolve with a reason…", the team's message button reads "Send reply to customer" or "Save internal note", the filing receipt names the ticket and says what happens next, and "Waiting on" says "Support team". The first resolve reason now reads "Fixed. Not customer-confirmed.", and a customer sees a team fix as "The team says it is fixed". A refused stale edit names only what the other person changed.
- **The customer's privacy and ownership.** An assistant's evidence reaches the customer only when the owner chose it in a question; no assistant is handed a ticket while the customer is answering; a reopened ticket whose owner left the team goes back to New with no owner.
- **The demo** resets once its data is over two hours old and nobody has made a request for thirty minutes, and its welcome page has one quiet line to the ticket an assistant worked. The README now fits five minutes; the tour, the settings and the build log sit under `docs/`.

### 2026-11-18, night: the demo opens on the list, and the list sorts by its headers

- **A first visit to the demo opens the product.** A visitor with no sign-in who opens the demo starts on the ticket list as the Demo Customer, under one welcome card: **File a sample ticket**, **See the team's side**, **See a ticket an AI assistant worked** and **Hide**. The roles sit in the **Switch role** menu. The old first page of choices is now **About this demo**, linked from every demo page's footer, with the privacy note, the source link and the folded assistant setup. This replaces the welcome page and its "Try the ticket workflow" above. The real site's sign-in page is unchanged.
- **The list sorts by its column headers.** Key, Title, Status, Owner and Filed sort the list, and a second press reverses it; a phone gets the same choices in a "Sort by" line. The sort is kept in the address as `sort` and `direction`, and the API takes the same two, with `updated` as well. This replaces the order choice under the table in the evening's entry; old `order` links still open the matching sort.

### 2026-11-19: a ticket shaped like a good prompt

The owner's reason for the product, in his words: "AIs do best when the prompts are basically broken into context, the problem, and testing so that they can verify whether the stated problem is complete." A ticket now has that shape: the title is the problem, the description the context, and "What would prove it is fixed?" the proof. Fixes and his explicit asks of the day; the three statuses are unchanged.

- **The proof is a second step.** The form asks for the title, the description and pictures; the filed ticket then asks "What would prove it is fixed?" with one box, Save and Skip for now. The customer can change it later. The edit form no longer holds it.
- **The list leads with proof.** A Proof column marks a ticket that says what would prove it is fixed, and the customer's Yes with a solid green check. By default, New tickets with a proof come first. All leaves out tickets resolved more than 14 days ago and says how many are under Resolved.
- **Marking fixed resolves.** The team's step is "Mark fixed and tell the customer": the ticket is resolved at once as "Fixed. Not customer-confirmed." and the customer is told. Their "Yes, it is fixed" is optional and marks it confirmed; their No reopens it with their words. The old ask stays under More options as "Ask before resolving". This replaces "Yes resolves the ticket" under the customer's side.
- **The ticket page is one centred column.** Status and Owner are two small menus under the title; the side panel, its row of three status buttons and the card are gone. Resolving from the Status menu opens one short form with five reasons.
- **The list.** The "Waiting on" column became a short tag after the status, shown only when it is not the team's turn. The search finds words in any order and form. The team can tick rows and change their status or owner together, from a bar over the filter row, by the same rules as one ticket.
- **Pictures** on a ticket and its messages, shown only to who may see what they are attached to; on the shared demo, only to the browser that added them.
- **Similar and duplicate tickets.** The form names one similar ticket while the title is typed, and the team's page names an older possible duplicate, with one press to close the ticket as its duplicate.
- **Sign-in.** Microsoft sign-in for one organization sits beside GitHub once its three settings are set. This replaces "other sign-in providers" in the list of things left out, for Microsoft only.
- **Suggested ways to prove a fix.** An admin sets each connection's Suggestions to Off, When asked or Automatic. A listening assistant answers a customer's request with up to three ways, which fill the step's box; the customer saves their own words. Never on a demo connection, and Proofdesk itself makes no AI calls.
- **Smaller.** The header is two groups with one person menu; the page after a key is one message to paste; one-job pages sit in a centred column; emails read like emails.
