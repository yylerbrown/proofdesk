# A tour of Proofdesk

The README walks one ticket from New to Resolved. This page goes feature by feature, for a reader
who wants to find each one on the demo, <https://support-desk-demo.fly.dev>.

## Try each feature in a minute

Each one takes under a minute on the demo, starting from its welcome page.

**Ticket submission: title, description, status**

- Start as: The welcome page
- Press: **Try the ticket workflow**, then **File ticket**
- You should see: The form says "Initial status: New" and is filled with a sample you can change. The filed ticket shows **New**.

**Ticket list with filters**

- Start as: **View as Demo Team Member**
- Press: **New**, **In Progress**, **Resolved**; **Mine** and **Unassigned**; type words, or a ticket's key such as SUP-3, and press **Search**; under the table, **Oldest first** or **Recently updated**
- You should see: "All tickets", with a count beside each status, and each filter changes the list. A typed key opens that ticket. Filters, search and order combine in the address, so a view can be shared. A customer's list is "My tickets": only their own, with the search.

**Update status: New to In Progress**

- Start as: The ticket you just filed, then **View this ticket as a team member**
- Press: **Take ticket and start work**, or **In Progress** in the Status row
- You should see: **In Progress**, with you as its owner. The Status row shows New, In Progress and Resolved, and each other status is one press; New sends an In Progress ticket back to the inbox with no owner.

**Update status: to Resolved**

- Start as: Demo Team Member, owning the ticket you filed
- Press: **Ask the customer to verify**, then **View this ticket as the customer who filed it** and **Yes, resolve ticket**
- You should see: **Resolved**, and "Customer confirmed it is fixed." Asking takes one press; what was tried, the change link and evidence are optional details. The team can also resolve without the customer, on a New ticket nobody owns or on one they own: press "Resolved" under Status and choose a reason, and the ticket then shows `Resolved by the team: <reason>` to everyone.

**Two people on one ticket**

- Start as: Demo Team Member, with the ticket you filed open in two tabs
- Press: **Edit ticket** in both tabs, save a change in one, then save in the other
- You should see: The second save is refused and keeps what you typed, naming what is different on the ticket now. A tab left open on a ticket someone else changed says "This ticket changed. Refresh to see it."

**SSO with roles and permissions**

- Start as: The production site, <https://proofdesk.fly.dev>
- Press: **Sign in with GitHub**
- You should see: Signed in as a customer, a team member or an admin, as [Sign-in and roles](../README.md#sign-in-and-roles) explains. On the demo the three roles are offered by name, the admin as **Admin preview (read-only)**.

**AI features**

- Start as: The welcome page
- Press: **Connect your own AI assistant**, then **Get a demo connection**, and paste the command into your own assistant, for example Claude Code
- You should see: Your assistant, through MCP, reads the sample ticket made for assistants and its check, proposes a test spec, writes notes and attaches evidence. **See an assistant's work**, in the same section, opens with what one real run did and resolved nothing. [`AGENTS_GUIDE.md`](AGENTS_GUIDE.md) has the setup.

**Creative extras**

- Start as: Any ticket
- Press: **How will we know it's fixed?** on the form; **Did this fix it?** for the customer
- You should see: The customer's own check stays on the ticket. Their Yes resolves it as "Customer confirmed"; a No goes back to the named owner with their words. Evidence is labelled as reported, never as verified. The history cannot be changed. Proofdesk writes an email notice to the customer or the owner when the ticket needs them, and a ticket's notices page (`/tickets/<key>/notices`, such as the ticket you filed) shows each one in its exact words.
