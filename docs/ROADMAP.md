# Roadmap

What comes after sending, in order, with an outside review's reasons. Proofdesk stays what its
README's first line says: a support desk where the customer says how to check a fix and gets to
say whether it worked. Proofdesk gives your agent the customer's definition of "fixed", and gives
the customer the final say on whether the fix worked. The customer's check is direction for the
agent, not its acceptance test: a test can pass while the customer is still stuck.

## First: a ticket's tests kept as regression tests

Each accepted scenario of a ticket's test spec gets a permanent id, such as `SUP-42/S1`. The test
in the product's own repository carries that id in its name. The desk records only "Reported
passing at commit <sha>" as evidence. If the test is later renamed or deleted, that record
stands; the desk marks a test retired only when the repository's owner says so. This keeps the
desk and the product apart: the repository owns its tests, and the desk keeps what was reported.

## After sending, in this order

| #   | What                             | How, and why                                                                                                                                                                                                                        |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Regression tests                 | As above: permanent scenario ids, carried in the test's name; the desk keeps "Reported passing at commit <sha>".                                                                                                                    |
| 2   | Agent comments at three moments  | When the assistant is blocked, when it needs a decision, and when its evidence is ready. Blocked notes and review requests already show beside the check and in the list; a decision with recognisable answers comes next.          |
| 3   | Photos and video                 | A screenshot can make a bug reproducible. On the public demo, a few bundled sample screenshots and clips to pick from, so strangers never upload anything; real uploads bring storage, access and permanent-deletion work.          |
| 4   | Search                           | Across a ticket's text, with the match shown. Permissions are checked before anything can match, so a customer's search never matches internal-note text.                                                                           |
| 5   | Agent descriptions with versions | A version and a few words on each connection, worth adding when the team has two versions to tell apart in the history.                                                                                                             |
| 6   | Reports                          | Compare versions on: reached the customer's check within 7 days; the customer replied within 7 days of the first ask; Yes on the first answer; reported broken within 30 days. Each is shown out of how many tickets it applies to. |
| 7   | A budget                         | A number the agent is asked to respect ("Aim for $10, then ask"), with the spend recorded as the agent reported it, or shown as unknown. The assistant runs outside Proofdesk, so the desk cannot enforce a limit.                  |
| 8   | The top bar                      | Crowding alone does not justify a navigation change. Every control in it was checked usable at 375 and 320 pixels wide.                                                                                                             |
| 9   | Personal assistant connections   | Each team member connects their own assistant. It can do no more than that person can, and the history labels it with their name. Admins can see and revoke every connection. This is the pattern of personal access tokens.        |
| 10  | Customers' own assistants        | A customer can get a key that reaches only their own tickets, so their assistant can file a ticket and follow it. Like every assistant, it cannot resolve: only the customer's own Yes does.                                        |

## Dropped

| What                                        | Why                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The list as an accordion                    | The status filters already split open from resolved; folding Resolved away would hide the fixes customers have confirmed behind an extra click.                                                 |
| "Agent tooling" as the umbrella             | It would make the product harder to recognise without giving the team or its customers anything new to do. "What would help an agent do this ticket well?" chooses improvements instead.        |
| A central AI with token limits per customer | Proofdesk makes no model calls of its own, so there is nothing to meter. The cost stays with whoever runs the assistant, and the desk never sends a customer's ticket text to a model provider. |

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
- **Quick answers:** plain words that fill the customer's No or the team's reply.
- **One recorded assistant run**, with its transcript, on the page "An assistant's work".
