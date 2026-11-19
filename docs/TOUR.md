# A tour of Proofdesk

This page shows where to find each feature on the demo, <https://support-desk-demo.fly.dev>. The
README's [One ticket, start to finish](../README.md#one-ticket-start-to-finish) walks one ticket.

## Try each feature in a minute

Each one takes under a minute on the demo, which opens on the ticket list as the Demo Customer.

**Ticket submission: title, description, status**

- Start as: The demo's first page, your ticket list as Demo Customer
- Press: **File a sample ticket** on the welcome card, then **File ticket**
- You should see: The form says "Initial status: New" and is filled with a sample you can change. The filed ticket shows **New**, under "Ticket SUP-n filed. The support team has it now; come back to this page for updates."

**Ticket list with filters**

- Start as: **Switch role**, then **View as Demo Team Member**
- Press: **New**, **In Progress**, **Resolved**; **Mine** and **Unassigned**; type words, or a ticket's key such as SUP-3, and press **Search**; a column header such as **Title** or **Filed**, then the same header again
- You should see: "All tickets", with a count beside each status and "Support team" under Waiting on for tickets the team owes an answer, and each filter changes the list. A typed key opens that ticket. A header sorts the list by its column, with an arrow on it, and a second press reverses it. Filters, search and sort combine in the address, so a view can be shared. On a phone the same sorts sit in a "Sort by" line above the list. A customer's list is "My tickets": only their own, with the search.

**Update status: New to In Progress**

- Start as: The ticket you just filed, then **View this ticket as a team member**
- Press: **Take ticket and start work**, or **In Progress** in the Status row
- You should see: **In Progress**, with you as its owner. The Status row shows New, In Progress and "Resolve with a reason…". New and In Progress are one press each, and "Resolve with a reason…" opens a short form. New sends an In Progress ticket back to the inbox with no owner.

**Update status: to Resolved**

- Start as: Demo Team Member, owning the ticket you filed
- Press: **Ask the customer to verify**, then **View this ticket as the customer who filed it** and **Yes, resolve ticket**
- You should see: **Resolved**, and "Customer confirmed it is fixed." Asking takes one press; what was tried, the change link and evidence are optional details. The team can also resolve without the customer, on a New ticket nobody owns or on one they own: press "Resolve with a reason…" under Status and choose a reason, such as "Fixed. Not customer-confirmed.", and the ticket then shows `Resolved by the team: <reason>` to everyone.

**Two people on one ticket**

- Start as: Demo Team Member, with the ticket you filed open in two tabs
- Press: **Edit ticket** in both tabs, save a change in one, then save in the other
- You should see: The second save is refused and keeps what you typed, naming only what the other person changed, such as `They changed: Title, now "..."`. A tab left open on a ticket someone else changed says what changed when it can, such as "This ticket is now In Progress. Refresh to see it." or "This ticket has a new message. Refresh to see it.", and otherwise "This ticket changed. Refresh to see it."

**GitHub sign-in with roles**

- Start as: The production site, <https://proofdesk.fly.dev>
- Press: **Sign in with GitHub**
- You should see: Signed in as a customer, a team member or an admin, as [Sign-in and roles](../README.md#sign-in-and-roles) explains. On the demo the three roles are in the **Switch role** menu, the admin as **Admin preview (read-only)**.

**AI features**

- Start as: **About this demo**, in the footer of every demo page
- Press: **Connect your own AI assistant**, then **Get a demo connection**, and paste the command into your own assistant, for example Claude Code
- You should see: Your assistant, through MCP, reads the sample ticket made for assistants and its check, proposes a test spec, writes notes and attaches evidence. **See an assistant's work**, in the same section, opens with what one real run did and resolved nothing. On the customer's welcome card, **See a ticket an AI assistant worked** opens one in the team's view. [`AGENTS_GUIDE.md`](AGENTS_GUIDE.md) has the setup.

**The customer's check, evidence and notices**

- Start as: Any ticket
- Press: **How will we know it's fixed?** on the form; **Did this fix it?** for the customer
- You should see: The customer's own check stays on the ticket. Their Yes resolves it as "Customer confirmed"; a No goes back to the named owner with their words. Evidence is labelled as reported, never as verified. The history cannot be changed. Proofdesk writes an email notice to the customer or the owner when the ticket needs them, and a ticket's notices page (`/tickets/<key>/notices`, such as the ticket you filed) shows each one in its exact words.
