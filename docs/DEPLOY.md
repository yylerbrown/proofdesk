# Deploying to Fly.io

Every step here is the owner's to run. Nothing in the repository creates accounts, disks,
secrets or machines.

The app `support-desk-demo` exists, at `https://support-desk-demo.fly.dev`. The settings are in
`fly.toml`: one machine, always on, with a disk at `/data` for the SQLite file.

## Before the first deploy

1. **A GitHub OAuth app for the hosted copy.** A second one, separate from the local one,
   because the callback address differs:
   - Homepage URL: `https://support-desk-demo.fly.dev`
   - Authorization callback URL: `https://support-desk-demo.fly.dev/api/auth/callback/github`
2. **The disk**, once:

   ```sh
   fly volumes create support_desk_data --app support-desk-demo --region sea --size 1
   ```

3. **The secrets.** Generate a new secret for production; do not reuse the local one. Set
   `ADMIN_GITHUB_IDS` to the GitHub user numbers of the admins (and `TEAM_GITHUB_IDS` for team
   members). A number can be read at `https://api.github.com/users/<user name>`.

   ```sh
   fly secrets set --app support-desk-demo \
     BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
     BETTER_AUTH_URL=https://support-desk-demo.fly.dev \
     GITHUB_CLIENT_ID=<from the OAuth app> \
     GITHUB_CLIENT_SECRET=<from the OAuth app> \
     ADMIN_GITHUB_IDS=<numbers>
   ```

   The server refuses to start in production without the four sign-in settings, or with an
   address that does not start with `https://`.

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
2. Sign in with GitHub on the hosted copy and see "(admin)" at the top.
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
