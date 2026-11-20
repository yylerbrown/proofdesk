# Roadmap

What comes after sending, in order, with an outside review's reasons and the owner's decisions.
Proofdesk stays what its README's first line says: a support desk where the customer says how to
check a fix and gets to say whether it worked. Proofdesk gives your agent the customer's definition
of "fixed", and gives the customer the final say on whether the fix worked. The customer's check is
direction for the agent, not its acceptance test: a test can pass while the customer is still stuck.

## First: a ticket's tests kept as regression tests

Each accepted scenario of a ticket's test spec gets a permanent id, such as `SUP-42/S1`. The test
in the product's own repository carries that id in its name. The desk records only "Reported
passing at commit <sha>" as evidence. If the test is later renamed or deleted, that record
stands; the desk marks a test retired only when the repository's owner says so. This keeps the
desk and the product apart: the repository owns its tests, and the desk keeps what was reported.

## After sending, in this order

| #   | What                             | How, and why                                                                                                                                                                                                                                              |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Regression tests                 | As above: permanent scenario ids, carried in the test's name; the desk keeps "Reported passing at commit <sha>".                                                                                                                                          |
| 2   | Agent comments at three moments  | When the assistant is blocked, when it needs a decision, and when its evidence is ready. Blocked notes and review requests already show beside the check and in the list; a decision with recognisable answers comes next.                                |
| 3   | Video                            | Pictures are built. A short clip can make a bug reproducible too; it brings larger storage, so it would live outside the database.                                                                                                                        |
| 4   | Search in the conversation       | The list already searches titles, descriptions and keys. Next: replies, and internal notes for the team, with the match shown. Permissions are checked before anything can match, so a customer's search never matches internal-note text.                |
| 5   | Agent descriptions with versions | A version and a few words on each connection, worth adding when the team has two versions to tell apart in the history.                                                                                                                                   |
| 6   | Reports                          | Compare versions on: reached the customer's check within 7 days; the customer replied within 7 days of the first ask; Yes on the first answer; reported broken within 30 days. Each is shown out of how many tickets it applies to.                       |
| 7   | A budget                         | A number the agent is asked to respect ("Aim for $10, then ask"), with the spend recorded as the agent reported it, or shown as unknown. The assistant runs outside Proofdesk, so the desk cannot enforce a limit.                                        |
| 8   | The top bar                      | Crowding alone does not justify a navigation change. Every control in it was checked usable at 375 and 320 pixels wide.                                                                                                                                   |
| 9   | Personal assistant connections   | Each team member connects their own assistant. It can do no more than that person can, and the history labels it with their name and marks it as an assistant. Admins can see and revoke every connection. This is the pattern of personal access tokens. |
| 10  | Customers' own assistants        | A customer can get a key that reaches only their own tickets, so their assistant can file a ticket and follow it. Like every assistant, it cannot answer for the customer or resolve a ticket.                                                            |
| 11  | How long a ticket has waited     | A "waiting on" filter that shows how long each ticket has waited on that person, with a "longest waiting" order, so the oldest wait is answered first. Asked for by testers walking the demo.                                                             |
| 12  | A filter by a named owner        | Beside Mine and Unassigned, a choice of one team member, for handing work over when someone is away or leaving. Asked for by testers walking the demo.                                                                                                    |

## Ideas, not promises

Each is one idea to weigh after sending, in no order.

- Several desks in one site, each with its own key prefix.
- The assistant leaving search words on a ticket, so the next person finds it.
- Forking a ticket that lists many problems into one ticket for each.
- A customer's own assistant checking a fix against their words.
- Releases the team tracks, so a fix's "Fixed in" names one of them.
- A "duplicates" view of the tickets closed as duplicates and what they point to.
- The customer's name in the queue, and a view of everything one customer filed.
- A priority and a due time on a ticket.
- The age of the last reply, and whose turn it is, on each row of the list.
- Keeping the selection after a bulk Apply, for a second change to the same tickets.

## Dropped

| What                                        | Why                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The list as an accordion                    | The status filters already split open from resolved; folding Resolved away would hide the fixes customers have confirmed behind an extra click.                                                                                 |
| "Agent tooling" as the umbrella             | It would make the product harder to recognise without giving the team or its customers anything new to do. "What would help an agent do this ticket well?" chooses improvements instead.                                        |
| A central AI with token limits per customer | Proofdesk makes no model calls of its own, so there is nothing to meter. The cost stays with whoever runs the assistant, and so does the choice of model provider: the desk itself never sends a customer's ticket text to one. |

## Smaller ideas from walking the demo

Each is one line, raised while the demo was walked before sending, to weigh after sending.

- An SLA clock beside a ticket's due time.
- Each ticket's real age on the list.
- Saved views, such as "needs my reply".
- Canned replies.
- Tags, and merging a duplicate into the ticket it repeats.
- A note to many tickets at once, and a note for the customer with a bulk Won't fix.
- Undo after a bulk change.
- Keyboard shortcuts: j and k to move through the list, a key for the search, Ctrl+Enter to send.
- The message box open by default.
- One fixed place for one-time lines, so a notice never moves the buttons under it.
- Shorter role names in the demo's menu, so the header does not shift when switching.
- Web addresses in a description shown as links, and a box on the form for the page it happened on.
- A live replay of the recorded assistant run, with its real times.
- A customer withdrawing their own ticket with a reason (a mistake, a duplicate, no longer needed),
  shown as Resolved and labelled as withdrawn by the customer.

## Already built

- **A named human owner** on every ticket in progress, with take, release and hand-off.
- **One assistant per ticket:** the owner hands a ticket to one connection, which sees only the
  tickets handed to it, through tools its scopes allow; the team page says who it is handed to.
- **Replies and internal notes**, each marked as written by a person or an agent. Internal notes
  are a scope of their own, off by default; only wording an assistant suggests for the customer
  is offered for publishing.
- **Evidence**, reported by whoever attached it and never shown as verified; an assistant's
  evidence reaches the customer only once the owner asks them.
- **Test specs:** an assistant proposes given / when / then scenarios, a person accepts one, and
  evidence can name the scenario it proves.
- **The blocked flag and review requests**, shown to the team beside the check and in the list.
- **One recorded assistant run**, with its transcript, on the page "An assistant's work".
- **Search** of titles, descriptions and ticket keys, by words in any order and form, with a
  count beside each status and a sort on each column header.
- **Email notices** written from the ticket history, with a page of each ticket's notices.
- **The People page**, where an admin chooses who is on the team.
- **Two people on one ticket:** a save or a press from an old copy is refused, and the typed text
  is kept.
- **Pictures** on tickets and messages, shown only to who may see what they are attached to.
- **The proof step:** "What would prove it is fixed?" after filing, the Proof column, New
  tickets with a proof listed first, and resolved tickets filtered by age.
- **Marking fixed resolves**, as the team member's agreement that the customer's proof was met,
  and the customer's "Did this fix it?" Yes is optional.
- **Changing many tickets at once** from the list, and **possible duplicates** closed in one press.
