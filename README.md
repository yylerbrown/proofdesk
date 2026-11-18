# Proofdesk

A customer support ticketing system. Customers file tickets with a title and a description, the
team works them through New, In Progress and Resolved, and everyone can filter and search the
list. The twist: the customer writes how they will know it is fixed, and the ticket asks them
"Did this fix it?" before it counts as confirmed.

- **The demo, no account needed: <https://support-desk-demo.fly.dev>.** Sample data, shared with
  everyone who visits, so do not type anything private. It returns to its samples by itself about
  once a day.
- **The production site, with GitHub sign-in: <https://proofdesk.fly.dev>.**
- **The source: <https://github.com/yylerbrown/proofdesk>.**

<img src="docs/img/ticket-list.png" width="720" alt="The team's ticket list on the demo: status filters All, New, In Progress, Resolved and Archived, owner filters Everyone, Mine and Unassigned, a search box, and eight sample tickets with their key, title, status, owner, who each one waits on and when it was filed">

## Run it yourself

You need Node 22.14 or newer (`node -v`; `.nvmrc` says 22). Clone the repository with
`git clone https://github.com/yylerbrown/proofdesk.git` and `cd proofdesk`, then:

```bash
npm ci
```

```bash
DEV_SIGN_IN=on npm run dev
```

Open <http://localhost:3000> and pick one of four made-up people. No keys are needed. The demo
mode, a production build, Docker and every setting are under [More ways to run](#more-ways-to-run).

## Try each feature in a minute

Each one takes under a minute on the demo, starting from its welcome page.

**Ticket submission: title, description, status**

- Start as: The welcome page
- Press: **Try the ticket workflow**, then **File ticket**
- You should see: The form says "Initial status: New" and is filled with a sample you can change. The filed ticket shows **New**.

**Ticket list with filters**

- Start as: **View as Demo Team Member**
- Press: **Tickets**, then **New**, **In Progress**, **Resolved**; **Mine** and **Unassigned**; or type words and press **Search**
- You should see: "All tickets", and each filter changes the list. They combine in the address, so a filtered view can be shared. A customer's list is "My tickets": only their own, with the search.

**Update status: New to In Progress**

- Start as: Demo Team Member, on a New ticket
- Press: **Take ticket and start work**
- You should see: **In Progress**, with you as its owner.

**Update status: to Resolved**

- Start as: Demo Team Member, owning the ticket
- Press: **Use sample fix** (or type any link and press **Save change link**), then **Ask the customer to verify**, then **View this ticket as the customer who filed it** and **Yes, resolve ticket**
- You should see: **Resolved**, and "Customer confirmed it is fixed." The owner can also resolve without the customer: press "Resolve" under Status and choose a reason, and the ticket then shows "Resolved by the team: <reason>" to everyone.

**A working product**

- Start as: The welcome page
- Press: **Try the ticket workflow**
- You should see: One ticket from New to Resolved, switching role on the same ticket, in about two minutes.

**Source on GitHub, and a README on how to run it**

- Start as: [github.com/yylerbrown/proofdesk](https://github.com/yylerbrown/proofdesk)
- Press: [Run it yourself](#run-it-yourself)
- You should see: A copy running on your own machine.

**A live URL**

- Press: The two links above
- You should see: The demo, and the production site.

**SSO with roles and permissions**

- Start as: The production site
- Press: **Sign in with GitHub**
- You should see: Signed in as a customer, a team member or an admin, as [Sign-in and roles](#sign-in-and-roles) explains. On the demo the three roles are offered by name, the admin as **Admin preview (read-only)**.

**AI features**

- Start as: The welcome page
- Press: **Get a demo connection**, then paste the command into your own assistant, for example Claude Code
- You should see: Your assistant, through MCP, reads a sample ticket and its check, proposes a test spec, writes notes and attaches evidence. **See an assistant's work**, also on the welcome page, shows one real run.

**Creative extras**

- Start as: Any ticket
- Press: **How will we know it's fixed?** on the form; **Did this fix it?** for the customer
- You should see: The customer's own check stays on the ticket. Their Yes resolves it as "Customer confirmed"; a No goes back to the named owner with their words. Evidence is labelled as reported, never as verified. The history cannot be changed.

This is what the customer meets when the team says it is fixed:

<img src="docs/img/did-this-fix-it.png" width="560" alt="The customer's view of a ticket the team says is fixed: the box &quot;Did this fix it?&quot; shows what the team tried, what happened and the customer's own check, with &quot;Yes, resolve ticket&quot; and a way to say No">

## Sign-in and roles

The production site signs people in with GitHub. Proofdesk reads your name, picture and email
address, never your code: it asks GitHub only for permission to read your email address, and
keeps no GitHub token after sign-in. Everyone starts as a customer.

| Role        | How you get it                                                                    | What you can do                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer    | Sign in.                                                                          | File tickets. Read, edit and reply on your own tickets, answer "Did this fix it?", and reopen a resolved ticket that is still broken. You never see the team's internal notes.                                                                        |
| Team member | The site's owner lists your GitHub user ID in `TEAM_GITHUB_IDS` in the settings.  | See every ticket. Take one and start work, reply, write internal notes, link the change, attach evidence, ask the customer to verify, archive and restore, hand on a ticket you own, resolve it with a reason, and reopen it if the team resolved it. |
| Admin       | The site's owner lists your GitHub user ID in `ADMIN_GITHUB_IDS` in the settings. | Everything a team member can, and resolve any open ticket with a reason, reopen any ticket the team resolved, issue AI assistant connections on **Connections** and delete a ticket permanently.                                                      |

On the demo there is no sign-in. Pick Demo Customer, Demo Team Member or Admin preview
(read-only) on the welcome page, and use **Switch role** beside "Signed in as" in the header to
try all three on the same page. Every visitor shares the one Demo Customer. The admin preview
sees everything, archived tickets included, and changes nothing. On the demo nobody archives or
deletes, so no visitor can empty it.

## The AI extra: connect your own assistant

Proofdesk makes no AI calls of its own. A person's own assistant can work on tickets through an
MCP endpoint, with only the permissions its connection allows. It gets the customer's
definition of "fixed" as direction, and only the customer's Yes confirms a fix: a test can pass
while the customer is still stuck.

On the demo, choose **Get a demo connection** on the welcome page: you get your own key for a
day, and the command to paste. For Claude Code it looks like this:

```bash
claude mcp add --transport http proofdesk \
  https://support-desk-demo.fly.dev/mcp \
  --header "Authorization: Bearer <your key>"
```

A demo connection sees only the sample ticket made for assistants and what it writes itself. An
assistant can read a ticket (which starts with the customer's check, as `done_when`), attach
evidence, and ask the owner to request the customer's check; it can never answer for the
customer or resolve. On the production site an admin issues connections, and a ticket's owner
hands the ticket to one with **Hand to an AI assistant**: an assistant sees only the tickets
handed to it. [`docs/AGENTS_GUIDE.md`](docs/AGENTS_GUIDE.md) has the setup for Claude Code and
Claude Desktop, the tools, the limits and a worked example.

## More ways to run

The development server keeps running until you stop it. To keep your settings in a file instead
of on the command line, copy `.env.example` to `.env`, which turns the dev login on; `npm run dev`
reads it. `npm ci` refuses a Node older than 22.14, because a dependency needs it; with nvm:
`nvm install 22 && nvm use 22`.

**The demo, locally**, on its own database:

```bash
DEV_SIGN_IN=off DEMO=on \
  DATABASE_PATH=./data/demo.db npm run dev
```

**A production build** reads only real environment variables, never `.env`:

```bash
npm run build
```

```bash
NODE_ENV=production DEMO=on \
  DATABASE_PATH=./data/demo.db npm start
```

For production with real tickets, leave out `DEMO=on` and pass the four GitHub settings below as
real environment variables, with an https `BETTER_AUTH_URL` and a database of its own, such as
`DATABASE_PATH=./data/app.db`. Production refuses an http address, and the server refuses a demo
database for real tickets.

**Docker.** Without keys, a container can only run as the demo. Give the demo its own volume: a
database records for good whether it is for the demo or for real tickets.

```bash
docker build -t proofdesk .
```

```bash
docker run --rm -p 3000:3000 -e DEMO=on \
  -v proofdesk-demo:/data proofdesk
```

A real run needs the four GitHub settings, with `-e` or `--env-file`, and a different volume.
`PORT` changes the port inside the container, so `-e PORT=8080` needs `-p 8080:8080`. Hosting on
Fly.io is in [`docs/DEPLOY.md`](docs/DEPLOY.md).

### Settings

All of them are in `.env.example`, with comments.

| Name                                                                                | What it does                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                          | `development`, `test` or `production`. Production refuses the dev login and requires https sign-in.                                                                         |
| `PORT`                                                                              | Default 3000.                                                                                                                                                               |
| `DATABASE_PATH`                                                                     | The SQLite file. Default `./data/app.db`.                                                                                                                                   |
| `TICKET_PREFIX`                                                                     | The letters before a ticket's number, default `SUP`. Fixed when the database is created.                                                                                    |
| `DEV_SIGN_IN`                                                                       | `on` offers four made-up people. Development only.                                                                                                                          |
| `DEMO`                                                                              | `on` makes this server the demo: sample data, three demo people, no GitHub sign-in.                                                                                         |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in. All four or none. Required in production unless `DEMO=on`.                                                                                                  |
| `TEAM_GITHUB_IDS`, `ADMIN_GITHUB_IDS`                                               | GitHub user IDs, separated by commas. Everyone else is a customer.                                                                                                          |
| `CLIENT_IP_HEADER`                                                                  | Behind a proxy, the header with the visitor's address, for rate limits. Fly.io: `fly-client-ip`.                                                                            |
| `DEMO_URL`                                                                          | Optional, on the production site: the demo's https address, linked from the sign-in page as "Try the demo without signing in".                                              |
| `REAL_SITE_URL`                                                                     | Optional, on the demo: the production site's https address, named on the welcome page as where GitHub sign-in with roles runs.                                              |
| `SOURCE_URL`                                                                        | Optional: the repository's https address. The welcome page then links **Source and setup** to its README, and `GET /api` names it. Both Fly apps set it to the public copy. |
| `PUBLIC_URL`                                                                        | Optional: the address people and assistants reach this server at, for the commands to paste. Else `BETTER_AUTH_URL`, else each request's own address. The demo sets it.     |
| `GIT_COMMIT`                                                                        | Reported by `GET /api/health`.                                                                                                                                              |

### GitHub sign-in

1. On GitHub, **Settings → Developer settings → OAuth Apps → New OAuth App**. Homepage URL: your
   address, for example `http://localhost:3000`. Authorization callback URL: the same address
   followed by `/api/auth/callback/github`.
2. Put its client id and a new client secret in `.env`, with `BETTER_AUTH_URL` set to the same
   address and `BETTER_AUTH_SECRET` set to the output of `openssl rand -base64 32`.
3. Set `DEV_SIGN_IN=off`. To make yourself an admin, put your GitHub user ID (the `id` at
   `https://api.github.com/users/<your user name>`) in `ADMIN_GITHUB_IDS`.

The `.env` file and the http address are for `npm run dev`. A production build (`npm start`)
does not read `.env` and refuses an http address: pass the four settings as real environment
variables, with an https `BETTER_AUTH_URL` and its own `DATABASE_PATH`, such as
`./data/app.db`.

## Read first

For someone reading the code, in this order:

1. [`src/server/permissions.ts`](src/server/permissions.ts): the capability table and `can()`,
   who may take each action.
2. [`src/server/tickets/service.ts`](src/server/tickets/service.ts): `markReady` (the owner
   asks "Did this fix it?"), `answer` (the customer's Yes or No) and `resolveWithReason`.
3. [`tests/confirmation.test.ts`](tests/confirmation.test.ts): the confirmation workflow on the
   real routes.
4. [`tests/capabilities.test.ts`](tests/capabilities.test.ts): every action, tested for agents
   from the capability table.
5. [`AGENTS.md`](AGENTS.md): the rules the coding assistant worked under.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) maps the rest of the code.

## How it is built

An Express 5 server in TypeScript (strict), SQLite through `better-sqlite3` with numbered
migrations, pages rendered on the server with EJS and Pico CSS, GitHub sign-in through Better
Auth, and zod for every input. Routes read the request and call the service; the ticket service
holds the rules and the transactions; repositories hold the SQL. The pages, the
[JSON API](docs/API.md) and the MCP endpoint call the same service functions.

`can()` decides by role, by agent scope and by who filed the ticket. Who owns the ticket and the
order of the workflow are checked in the ticket service. Every change writes an add-only history
entry in the same transaction, and database triggers refuse to change it.

## How it is verified

| Command                | What it runs                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`             | Every unit and route test with vitest, over 1,000 of them, against a real SQLite file and the real app.                                                                                                                                       |
| `npm run test:browser` | Real-browser tests with Playwright: one journey where a customer files, the team works it, No then Yes, and a second customer is refused; then the keyboard, menus and phone layout. Run `npx playwright install chromium webkit` once first. |
| `npm run typecheck`    | TypeScript, strict.                                                                                                                                                                                                                           |
| `npm run lint`         | ESLint.                                                                                                                                                                                                                                       |
| `npm run format:check` | Prettier, without changing files. `npm run format` rewrites them.                                                                                                                                                                             |

All of them pass before a pull request merges, with one early exception that
[`AGENTS.md`](AGENTS.md) names. GitHub's CI ran them until 18 November, when it stopped starting
jobs on the private working repository; since then a local gate runs the same commands on the
exact commit being merged. Many changes were also broken on purpose to see their
test fail; each pull request says which. A few tests read this README, so a route, label or
command it names cannot drift from the code.
Pull request numbers, here and in [`BUILD_LOG.md`](BUILD_LOG.md), refer to the private working
repository, which stays private; the public copy's `docs/PULL_REQUESTS.md` holds each one's title
and description.

## How the work was directed

An AI coding assistant wrote the implementation. The owner defined the behaviour, broke the work
into small changes and directed the checking, including outside reviews of the design and the
code. The specification ([`docs/SPEC.md`](docs/SPEC.md)), the history of every step
([`BUILD_LOG.md`](BUILD_LOG.md)) and the checks are in the repository.

## Known limits

- **Last writer wins** for edits to a ticket and to the team's check. Only the customer's answer
  carries a version check, so an old page cannot answer a newer question.
- **No email is sent yet.** Nobody is told when something changes; people look at the ticket.
- **Evidence is reported, not verified.** Proofdesk shows who reported it and checks none of it.
- **One machine.** SQLite on one disk; rate-limit counts are in memory and reset on a restart.
  Several machines would need Postgres and a shared store for the rate limits.
- **Roles are set in the server settings.** The site's owner names team members and admins by
  GitHub user ID; there is no page for it yet.
- **Demo visitors share identities.** Everyone who views as Demo Customer is the same customer.
- **The dev login's cookie is unsigned.** It is safe only because production refuses the dev
  login.
- **`ops/prove` is not a sandbox.** It runs the candidate code on the machine with only the
  environment cleaned, and its check for skipped or focused tests is a text match.
- **Permanent deletion** does not reach backups or the host's disk snapshots until they expire.
- **Left out on purpose:** a board with status columns or dragging, priority ordering, any model
  call of the site's own, reassigning tickets when someone leaves the team, human review
  decisions recorded against each piece of evidence, an immutable record of each question asked
  beyond its history entry, documentation generated from conditional rules, and upgrading
  tickets resolved before the customer's Yes was required.
- **Design debt** in the code, such as a ticket service of over 2,000 lines, is listed with the
  plan for each item in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#design-debt).

## More

- [`docs/API.md`](docs/API.md): every JSON route, errors, retries, and trying it with `curl`.
- [`docs/SECURITY.md`](docs/SECURITY.md): the security measures and their tests, and permanent
  deletion.
- [`docs/DEPLOY.md`](docs/DEPLOY.md): the two Fly.io apps, resetting the demo, backups.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): what comes next, first a ticket's tests kept as
  regression tests with a permanent id such as `SUP-42/S1`.
- [`docs/SPEC.md`](docs/SPEC.md): what was decided, and when it changed.
- [`BUILD_LOG.md`](BUILD_LOG.md): how each step was asked for, what came back and what was found.
