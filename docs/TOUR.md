# A tour of Proofdesk

This page shows where to find each feature on the demo, <https://support-desk-demo.fly.dev>. The
README's [One ticket, start to finish](../README.md#one-ticket-start-to-finish) walks one ticket.

## Try each feature in a minute

Each one takes under a minute on the demo, which opens on the ticket list as the Demo Customer.

**Ticket submission: title, description, status**

- Start as: The demo's first page, your ticket list as Demo Customer
- Press: **File a sample ticket** on the welcome card, then **File ticket**
- You should see: The form holds a sample you can change: Title ("The problem, in a few words."), Description ("The context: what you were doing, and what happened.") and Add pictures. The filed ticket shows New, under "Ticket SUP-n filed. The support team has it now; come back to this page for updates.", and opens on the step below.

**What would prove it is fixed**

- Start as: The ticket you just filed, on its second step
- Press: **Save**, or **Skip for now**; later, **Change** beside the label
- You should see: "What would prove it is fixed?", one grey line, one box, **Save** and **Skip for now**. On the demo three labelled sample suggestions sit above the box, the first already in it. Saved words are quoted under the label, with "Saved. The team will check the fix against it." once. A ticket with none shows its filer "Add what would prove it". The team cannot write it; it is the customer's own words. A form or API call that already carries it files the ticket without the step.

**Ticket list with filters**

- Start as: The menu at the top right, then **Demo Team Member**
- Press: **New**, **In Progress**, **Resolved**; **Mine** and **Unassigned**; type words, or a ticket's key such as SUP-3, and press Enter; a column header such as **Title** or **Filed**, then the same header again
- You should see: "All tickets", with a count beside each status, and each filter changes the list; a lit filter pressed again clears it. A typed key opens that ticket. Words match in any order and form, so "sign in phone" finds "Cannot sign in on my phone". A header sorts the list by its column, with an arrow on it, and a second press reverses it. Filters, search and sort combine in the address, so a view can be shared. On a phone the same sorts sit in a "Sort by" line above the list. A short grey tag follows the status when it is not simply the team's turn, such as "Customer says not fixed" or "Assistant asks for review". A customer's list is "My tickets": only their own, with the search, and "Did this fix it?" on a ticket waiting for their answer.

**The Proof column and the list's order**

- Start as: Demo Team Member, on All tickets
- Press: Nothing at first; then a column header, to sort by it instead
- You should see: A narrow **Proof** column after Status. One mark says the ticket states what would prove it is fixed, and a solid green check says the customer confirmed it. With no header pressed, New tickets that say what would prove them fixed come first, newest first, then the other open tickets, then resolved ones. All shows open tickets and those resolved in the last 14 days; a line under the list says how many older resolved tickets are under Resolved.

**Update status: New to In Progress**

- Start as: The ticket you just filed, then **View this ticket as a team member**
- Press: **Take ticket and start work**, or the **Status** menu under the title, then In Progress
- You should see: **In Progress**, with you as its owner. Status and Owner are two small menus under the title. Status lists New, In Progress and Resolved with the current one marked, and on a ticket nobody owns its choice reads "In Progress (assigns it to you)". New sends an In Progress ticket back to the inbox with no owner. Owner holds Assign to me, Assign to and Unassign, as the rules allow.

**Update status: to Resolved**

- Start as: Demo Team Member, owning the ticket you filed
- Press: **Mark fixed and tell the customer**, then **View this ticket as the customer who filed it** and **Yes, it is fixed**
- You should see: The ticket is resolved at once: "Resolved by the team: Fixed. Demo Team Member, <day>. The customer has not confirmed it." The customer reads "Did this fix it?" over their own words. Their Yes is optional and shows "Resolved, customer confirmed" with the solid check in the list. "No, it is not fixed" asks "What is still wrong?", and "No, send it back" reopens the ticket with their words. The Status menu's Resolved opens "Why are you resolving this ticket?" with five reasons, from "Fixed (the customer is told)" to "Other", and the ticket shows `Resolved by the team: <reason>` to everyone. To ask the customer before resolving, use **Ask before resolving** under **More options**.

**Possible duplicates**

- Start as: Demo Customer, on **New ticket**
- Press: Type a title like an open ticket's, such as "Cannot sign in on my phone after the update", and pause; file it, then **View this ticket as a team member**
- You should see: Under the Title box, "Similar ticket: SUP-3 Cannot sign in on my phone (In Progress)", a link that opens in a new tab so the form is kept. On the team's page, "Possible duplicate: SUP-3 Cannot sign in on my phone" and "Close as a duplicate of SUP-3", which resolves it as a duplicate in one press. Only an older ticket is named, the line never shows on a demo sample itself, and customers never see it.

**Pictures**

- Start as: The new ticket form, or any ticket's message box
- Press: **Add pictures**, or paste a screenshot into the box
- You should see: Each chosen picture as a small square with its own remove button; after sending, small squares under the words, each opening the full picture. PNG, JPEG, GIF or WebP, up to 2 MB each and 4 at a time (1 MB and 2 on the demo). A picture is shown to whoever may see what it is attached to. On the shared demo a visitor's picture is shown only to the browser that added it, and everyone else reads one grey line in its place. The dark-mode sample carries one drawn picture for the team.

**Change many tickets at once**

- Start as: Demo Team Member, on All tickets
- Press: The tick box before two keys, then **Set status** or **Assign to**, and **Apply**
- You should see: A bar over the filter row, "2 selected", with Set status, Assign to, Apply and Clear; it stays in view while scrolling. Resolved there offers three reasons. One line after Apply says what moved and why the rest did not, such as "1 moved to Resolved. 1 was not changed:" with each key left as it was and its reason. Each ticket goes through the same rules as on its own page.

**Two people on one ticket**

- Start as: Demo Team Member, with the ticket you filed open in two tabs
- Press: **More options**, then **Edit ticket** in both tabs, save a change in one, then save in the other
- You should see: The second save is refused and keeps what you typed, naming only what the other person changed, such as `They changed: Title, now "..."`. A tab left open on a ticket someone else changed says what changed when it can, such as "This ticket is now In Progress. Refresh to see it." or "This ticket has a new message. Refresh to see it.", and otherwise "This ticket changed. Refresh to see it."

**GitHub sign-in with roles**

- Start as: The production site, <https://proofdesk.fly.dev>
- Press: **Sign in with GitHub**
- You should see: Signed in as a customer, a team member or an admin, as [Sign-in and roles](../README.md#sign-in-and-roles) explains. Microsoft sign-in for one organization sits beside it once its settings are set. On the demo the three roles are in the menu at the top right, the admin as Demo Admin (read-only).

**AI features**

- Start as: **About this demo**, in the footer of every demo page
- Press: **Connect your own AI assistant**, then **Get a demo connection**, and paste the message it gives into your own assistant, for example Claude Code
- You should see: Your assistant, through MCP, reads the sample ticket made for assistants and its check, proposes a test, writes notes and attaches evidence, then asks the ticket's owner to review it. **See an assistant's work**, in the same section, opens with what one real run did and resolved nothing. On the customer's welcome card, "See a ticket an AI assistant worked, as the team" opens one in the team's view. [`AGENTS_GUIDE.md`](AGENTS_GUIDE.md) has the setup.

**Suggested ways to prove a fix**

- Start as: An admin on Connections, on the real site or the development entrance
- Press: The connection's Suggestions choice: Off, When asked or Automatic
- You should see: Off is the default and a demo connection never has it. With When asked, the customer's step shows a quiet "Suggest ways to prove it"; with Automatic, the step asks by itself. A listening assistant answers within seconds with up to three choices, under "Suggested by the team's AI assistant. Pick one to fill the box, then edit it if you like." Picking one fills the box; the customer saves their own words. Proofdesk makes no AI calls itself, and with nothing listening the step says nothing about an assistant.

**Evidence, history and email notices**

- Start as: Any ticket, as the team
- Press: **History**, and **More options**
- You should see: Evidence is labelled as reported, never as verified, and the history cannot be changed. Proofdesk writes an email notice to the customer or the owner when the ticket needs them; marking a ticket fixed sends "Did this fix it?" with the customer's own words. A ticket's notices page (`/tickets/<key>/notices`, such as the ticket you filed), linked under More options once there is one, shows each notice in its exact words.
