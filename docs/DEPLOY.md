# Running and deploying

This page runs Proofdesk beyond `npm run dev`: [on your machine or in Docker](#more-ways-to-run),
with every setting, then on Fly.io. The README's [Run it yourself](../README.md#run-it-yourself)
has the two commands that start it.

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
Fly.io is [below](#flyio).

### Settings

All of them are in `.env.example`, with comments.

| Name                                                                                | What it does                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                          | `development`, `test` or `production`. Production refuses the dev login and requires https sign-in.                                                                        |
| `PORT`                                                                              | Default 3000.                                                                                                                                                              |
| `DATABASE_PATH`                                                                     | The SQLite file. Default `./data/app.db`.                                                                                                                                  |
| `TICKET_PREFIX`                                                                     | The letters before a ticket's number, default `SUP`. Fixed when the database is created.                                                                                   |
| `DEV_SIGN_IN`                                                                       | `on` offers four made-up people. Development only.                                                                                                                         |
| `DEMO`                                                                              | `on` makes this server the demo: sample data, three demo people, no GitHub sign-in.                                                                                        |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in. All four or none. Required in production unless `DEMO=on`.                                                                                                 |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`             | Optional: Microsoft sign-in beside GitHub, for one organization. All three or none, and only with the four above.                                                          |
| `TEAM_GITHUB_IDS`, `ADMIN_GITHUB_IDS`                                               | GitHub user IDs, separated by commas. These people keep that role and show as locked on **People**; an admin chooses everyone else's, a customer by default.               |
| `CLIENT_IP_HEADER`                                                                  | Behind a proxy, the header with the visitor's address, for rate limits. Fly.io: `fly-client-ip`.                                                                           |
| `DEMO_URL`                                                                          | Optional, on the production site: the demo's https address, linked from the sign-in page as "Try the demo without signing in".                                             |
| `REAL_SITE_URL`                                                                     | Optional, on the demo: the production site's https address, named on About this demo as where GitHub sign-in with roles runs.                                              |
| `SOURCE_URL`                                                                        | Optional: the repository's https address. About this demo then links **Source and setup** to its README, and `GET /api` names it. Both Fly apps set it to the public copy. |
| `PUBLIC_URL`                                                                        | Optional: the address people and assistants reach this server at, for the commands to paste. Else `BETTER_AUTH_URL`, else each request's own address. The demo sets it.    |
| `SMTP_URL`, `MAIL_FROM`                                                             | Optional: the mail server (`smtps://user:password@host:465`) and the sender for email notices. Both or neither. Without them, or on the demo, nothing is sent.             |
| `GIT_COMMIT`                                                                        | Reported by `GET /api/health`.                                                                                                                                             |

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

### Microsoft sign-in, beside GitHub

Optional, for one organization, and off until all three Microsoft settings are set: until then
there is no button and no Microsoft route. It needs the four GitHub settings too.

1. In the Microsoft Entra admin center, **App registrations → New registration**, single
   tenant, with the redirect URI (platform **Web**) your address followed by
   `/api/auth/callback/microsoft`.
2. Copy the **Application (client) ID** into `MICROSOFT_CLIENT_ID`, the **Directory (tenant)
   ID** into `MICROSOFT_TENANT_ID`, and a new client secret's **Value** (under **Certificates &
   secrets**; note when it expires) into `MICROSOFT_CLIENT_SECRET`.
3. **Token configuration → Add optional claim → ID**: tick `email` and `xms_edov`, which says
   the organization owns the address's domain. Without them everyone is refused for want of a
   verified email address.

Proofdesk asks only for `openid`, `profile` and `email`, so the default `User.Read` permission
can be removed. Newcomers are customers; an admin chooses roles on **People**, which shows how
each person signed in. An email address used one way cannot sign in the other way.

## Fly.io

Every step here is the owner's to run. Nothing in the repository creates accounts, disks,
secrets or machines.

There are two apps, both in the `sjc` region, each with one machine, always on, and its own disk
named `support_desk_data` at `/data` for the SQLite file:

| App                 | Address                             | Settings             | What it is                                                                               |
| ------------------- | ----------------------------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| `support-desk-demo` | `https://support-desk-demo.fly.dev` | `fly.toml`           | The public demo: `DEMO=on`, the three demo people and sample tickets, no GitHub sign-in. |
| `proofdesk`         | `https://proofdesk.fly.dev`         | `fly.proofdesk.toml` | The real site, with GitHub sign-in.                                                      |

A database records whether it is for the demo or for real tickets, and the server refuses to
start on the wrong one, so the two can never share a disk.

## The disks

Made once, already done:

```sh
fly volumes create support_desk_data --app support-desk-demo --region sjc --size 1
fly volumes create support_desk_data --app proofdesk --region sjc --size 1
```

## The real site's sign-in

Done once, already done:

1. **A GitHub OAuth app for it**, separate from the local one, because the callback address
   differs:
   - Homepage URL: `https://proofdesk.fly.dev`
   - Authorization callback URL: `https://proofdesk.fly.dev/api/auth/callback/github`
2. **The secrets.** Generate a new secret for production; do not reuse the local one. Set
   `ADMIN_GITHUB_IDS` to the GitHub user numbers of the admins (and `TEAM_GITHUB_IDS` for team
   members). A number can be read at `https://api.github.com/users/<user name>`. Name at least
   one admin here: the server warns at start when none is named. Everyone else is chosen on the
   site's People page by an admin, and it applies at once; the people named here keep their role
   and show there as locked. Removing an admin from `ADMIN_GITHUB_IDS` ends the assistant
   connections they issued at the next restart, and the log says how many.

   ```sh
   fly secrets set --app proofdesk \
     BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
     BETTER_AUTH_URL=https://proofdesk.fly.dev \
     GITHUB_CLIENT_ID=<from the OAuth app> \
     GITHUB_CLIENT_SECRET=<from the OAuth app> \
     ADMIN_GITHUB_IDS=<numbers>
   ```

   The server refuses to start in production without the four sign-in settings, or with an
   address that does not start with `https://`.

Not done yet: **Microsoft sign-in.** Register an app as above with the redirect URI
`https://proofdesk.fly.dev/api/auth/callback/microsoft`, then set the three Microsoft settings
with `fly secrets set --app proofdesk`; the site restarts with both buttons.

The commands below name the demo app; for the real site use `--app proofdesk`.

**The real site always deploys with `--config fly.proofdesk.toml`.** `fly.toml` sets `DEMO=on`;
deployed with it, the real site refuses to start, as designed.

## Email notices

Off until `SMTP_URL` and `MAIL_FROM` are both set; the real site has neither today. Without them
every notice is kept as not sent, with the reason, and nothing is emailed. The demo never sends,
whatever is set.

1. **A mail provider account** that sends over SMTP, with a sending domain it has checked. The
   site's owner creates it; it is not part of this repository.
2. **The secrets.** The address holds the provider's password, so it goes in as a secret:

   ```sh
   fly secrets set --app proofdesk \
     SMTP_URL="smtps://<user>:<password>@<provider's SMTP host>:465" \
     MAIL_FROM=<an address on the checked domain>
   ```

   Percent-encode any `/`, `+`, `#`, `@` or `:` in the user or password, for example `/` as
   `%2F`, `+` as `%2B` and `@` as `%40`; without it the server refuses the address at start.
   With `smtp://` the server must offer an encrypted connection before the sign-in, or nothing
   is sent; `smtps://` is encrypted from the start.

   The server refuses to start with one of the two and not the other. It never prints the
   address of the mail server, in a log line, an error or the health check.

   Deploy the change that sends email first and let it start once before setting the two
   secrets. That first start writes the notices of every change since email notices were added,
   and without the secrets they are kept as not sent rather than mailed late.

3. **Check it.** The log says "Email notices are sent through the mail server that is set." at
   start. Mark a test ticket fixed: the customer's "Did this fix it?" email arrives within
   seconds.
   A notice that could not be sent is tried five times, waiting longer each time, and then kept
   as failed with a short reason in the `email_outbox` table.

Only addresses GitHub verified are mailed, and only to the people the notice rules name who left
"Email me about my tickets" on, on their account page. Each ticket's notices page,
`/tickets/<key>/notices`, shows what it sent or would have sent.

## Deploy

By hand, from the project folder:

```sh
fly deploy --app support-desk-demo --build-arg GIT_COMMIT=$(git rev-parse HEAD)
fly deploy --config fly.proofdesk.toml --build-arg GIT_COMMIT=$(git rev-parse HEAD)
```

Or from GitHub: create a deploy token with `fly tokens create deploy --app support-desk-demo`,
save it as the repository secret `FLY_API_TOKEN`, and run the **Deploy** workflow from the
Actions tab. It never runs on its own, and it deploys the demo (`fly.toml`) only.

With one machine and one disk, each deploy has a few seconds of downtime.

## Resetting the demo

The demo resets itself when it has been quiet for a while (`src/server/demo-reset.ts`). Every 5
minutes it checks. Once its data is more than 2 hours old and nobody has made a request for 30
minutes, it moves its database files aside in `/data`, named like
`app.db.before-reseed-20261118-142501` (UTC), and serves a fresh database with the samples. If it
is never quiet that long, it resets at 48 hours. The host's health checks do not count as
requests. The three newest set-aside copies are kept and older ones are deleted. Visitors'
tickets and demo assistant connections end with the reset. Each reset writes one line to the
log; a reset that fails leaves the old data serving and is tried again at the next check. A demo
started or redeployed with samples older than 2 hours resets as it starts. The real site never
resets.

The demo adds its sample tickets only to an empty database, so new samples, and assistant
connections on a database seeded by older code, appear only after a reset. To force one now,
move the database files aside on the disk, then restart the machine; it starts on an empty
database and seeds it:

```sh
fly ssh console --app support-desk-demo
mkdir /data/set-aside
mv /data/app.db* /data/set-aside/
exit
fly machine restart --app support-desk-demo
```

`app.db*` is the database and its two companion files, `app.db-wal` and `app.db-shm`. The
set-aside folder keeps what visitors wrote; delete it when it is no longer needed.

## The source link

The demo's About this demo page links **Source and setup** to the README of the public copy,
<https://github.com/yylerbrown/proofdesk>, and `GET /api` names it, from `SOURCE_URL` in both `fly.toml` and
`fly.proofdesk.toml`. That copy is republished after each batch of merges; the working repository
stays private, so nothing links to it.

## After every deploy

1. `curl https://support-desk-demo.fly.dev/api/health` and
   `curl https://proofdesk.fly.dev/api/health` both answer `"status":"ok"` with the commit.
2. The demo opens on the customer's ticket list, About this demo offers **Get a demo connection**,
   and `/api/health` answers `"assistant_connections":"ready"`. If it says `needs_reset`, or the
   start-up log says so, reset the demo.
3. The real site's sign-in page shows **Sign in with GitHub** and **Try the demo without signing
   in**.

## After the first deploy: first, does it start?

The image starts as root only to hand the mounted disk to the `node` user, then runs the
server as `node` (`docker-entrypoint.sh`). This could not be tried on a real Fly disk before
deploying. Look at `fly logs` straight after the first deploy: it must show `Listening on port
3000`, not a permission error on `/data/app.db`, and the machine must not restart over and over.

## After the first deploy: five checks

1. `curl https://support-desk-demo.fly.dev/api/health` answers `"status":"ok"` with the commit.
2. On the demo, choose "View as Demo Admin" and see the `admin` label at the top. On the real
   site, sign in with GitHub instead.
3. **The visitor's address cannot be chosen by the visitor.** The server counts sign-in starts
   per address, ten a minute, reading the address from the `fly-client-ip` header that Fly's
   proxy sets. Fly's documentation does not say whether the proxy replaces a value a visitor
   sends. Check it: send eleven sign-in starts, each claiming a different address.

   ```sh
   for i in $(seq 1 11); do
     curl -s -o /dev/null -w "%{http_code}\n" -X POST \
       -H "Origin: https://support-desk-demo.fly.dev" -H "fly-client-ip: 10.0.0.$i" \
       https://support-desk-demo.fly.dev/sign-in/github
   done
   ```

   The eleventh must answer `429`. If all eleven answer `303`, a visitor can choose their own
   address: remove `CLIENT_IP_HEADER` from `fly.toml` and ask for a different setting. Then
   run it again without the `fly-client-ip` line; the eleventh must answer `429` too.

4. **A doubled header.** Repeat check 3 with the header sent twice in each request
   (`-H "fly-client-ip: 10.0.0.$i" -H "fly-client-ip: 10.0.1.$i"`). The eleventh must still
   answer `429`.
5. **No way around the proxy.** The server must only be reachable through Fly's proxy at
   `support-desk-demo.fly.dev`, never directly on the machine's own address and port 3000;
   otherwise anyone could send their own address header. Check `fly ips list` shows only the
   app's shared or dedicated addresses, and that `fly.toml` declares no other `[[services]]`.

## The data survives a restart

```sh
fly machine restart --app support-desk-demo
```

Then check that tickets filed before the restart are still there.

## Backups

Do not copy `app.db` while the server runs: part of the data is in `app.db-wal`, and a plain copy
can be broken. Use SQLite's own backup, which is safe while the app runs:

Open a console on the machine, make the backup from `/app` (where the server's packages are),
then fetch it and remove the copy from the live disk, or tickets deleted later would survive
in it:

```sh
fly ssh console --app support-desk-demo
cd /app
node -e "require('better-sqlite3')('/data/app.db').backup('/data/backup.db').then(() => console.log('done'))"
exit
```

```sh
fly ssh sftp get /data/backup.db ./backup.db --app support-desk-demo
fly ssh console --app support-desk-demo -C "rm /data/backup.db"
```

A permanently deleted ticket stays in backups made before its deletion, and in the host's
automatic snapshots of the disk until they expire. `fly volumes snapshots list` shows which
snapshots exist; how long they are kept is a host setting to check before going live.

## Rolling back

```sh
fly releases --app support-desk-demo
fly deploy --app support-desk-demo --image <image of the release to go back to>
```

A rollback does not undo database migrations. Most migrations only add columns and tables, so
older code runs on a newer database. One does more: `0008` rebuilds the tickets table, and code
from before it does not know the deletion record. Check `migrations/` before rolling back past
one.
