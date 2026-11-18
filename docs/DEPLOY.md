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

## After the first deploy: three checks

1. `curl https://support-desk-demo.fly.dev/api/health` answers `"status":"ok"` with the commit.
2. Sign in with GitHub on the hosted copy and see "(admin)" at the top.
3. **The visitor's address.** Not verified before deploying: `fly.toml` tells the server to read
   the visitor's address from the `fly-client-ip` header, which Fly's proxy sets. Fly's
   documentation does not say whether the proxy replaces a value a visitor sends in that header.
   Check it with:

   ```sh
   curl -s -H "fly-client-ip: 1.2.3.4" https://support-desk-demo.fly.dev/api/health -D - -o /dev/null
   ```

   then look in `fly logs` for the address the server saw on that request. If it is `1.2.3.4`,
   a visitor can choose their own address and the per-address rate limit can be dodged; remove
   `CLIENT_IP_HEADER` from `fly.toml` and use `X-Forwarded-For` with a trusted proxy count
   instead.

## The data survives a restart

```sh
fly machine restart --app support-desk-demo
```

Then check that tickets filed before the restart are still there.

## Backups

Do not copy `app.db` while the server runs: part of the data is in `app.db-wal`, and a plain copy
can be broken. Use SQLite's own backup, which is safe while the app runs:

```sh
fly ssh console --app support-desk-demo -C "node -e \"new (require('better-sqlite3'))('/data/app.db').backup('/data/backup.db')\""
fly ssh sftp get /data/backup.db ./backup.db --app support-desk-demo
```

A permanently deleted ticket stays in backups made before its deletion.

## Rolling back

```sh
fly releases --app support-desk-demo
fly deploy --app support-desk-demo --image <image of the release to go back to>
```

A rollback does not undo database migrations. Every migration so far only adds, so older code
runs on a newer database, but check `migrations/` before rolling back past one.
