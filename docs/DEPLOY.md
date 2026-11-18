# Deploying to Fly.io

Every step here is the owner's to run. Nothing in the repository creates accounts, disks,
secrets or machines.

The app `support-desk-demo` runs the **public demo** at `https://support-desk-demo.fly.dev`:
`DEMO=on`, set in `fly.toml`, so it offers the three demo people, sample tickets and no
GitHub sign-in. The settings are in `fly.toml`: one machine, always on, in the `sjc` region,
with the disk `support_desk_data` at `/data` for the SQLite file.

The real site, with GitHub sign-in, would be a **second app with its own disk**. A database
records whether it is for the demo or for real tickets, and the server refuses to start on the
wrong one, so the two can never share a disk.

## The demo app's disk

Made once, already done:

```sh
fly volumes create support_desk_data --app support-desk-demo --region sjc --size 1
```

## A second app for the real site

Not made yet. It needs its own app name, its own copy of `fly.toml` without `DEMO`, and its
own disk (the same command as above, with its app name). Then:

1. **A GitHub OAuth app for it**, separate from the local one, because the callback address
   differs:
   - Homepage URL: `https://<app name>.fly.dev`
   - Authorization callback URL: `https://<app name>.fly.dev/api/auth/callback/github`
2. **The secrets.** Generate a new secret for production; do not reuse the local one. Set
   `ADMIN_GITHUB_IDS` to the GitHub user numbers of the admins (and `TEAM_GITHUB_IDS` for team
   members). A number can be read at `https://api.github.com/users/<user name>`.

   ```sh
   fly secrets set --app <app name> \
     BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
     BETTER_AUTH_URL=https://<app name>.fly.dev \
     GITHUB_CLIENT_ID=<from the OAuth app> \
     GITHUB_CLIENT_SECRET=<from the OAuth app> \
     ADMIN_GITHUB_IDS=<numbers>
   ```

   The server refuses to start in production without the four sign-in settings, or with an
   address that does not start with `https://`.

The rest of this guide names the demo app; use the second app's name for the real site.

## Deploy

By hand, from the project folder:

```sh
fly deploy --app support-desk-demo
```

Or from GitHub: create a deploy token with `fly tokens create deploy --app support-desk-demo`,
save it as the repository secret `FLY_API_TOKEN`, and run the **Deploy** workflow from the
Actions tab. It never runs on its own.

With one machine and one disk, each deploy has a few seconds of downtime.

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
