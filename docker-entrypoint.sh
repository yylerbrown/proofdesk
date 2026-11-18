#!/bin/sh
# Starts the server as the unprivileged "node" user, with /data writable by it.
#
# The host mounts its disk over /data when the machine starts. That disk may belong to
# root, which would stop "node" from opening the database. So this script starts as root,
# hands /data to "node", then runs the server as "node" and nothing else as root.
set -e
chown node:node /data
exec setpriv --reuid=node --regid=node --init-groups "$@"
