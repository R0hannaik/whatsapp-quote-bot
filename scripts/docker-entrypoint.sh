#!/bin/sh
# Starts the app as the unprivileged "node" user.
# Hosting platforms (Render, Fly.io, Railway…) mount their persistent disk owned by root, so when the container starts
# as root we first hand the data folder to "node", then drop root for good before the app starts.
set -e
DIR="${DATA_DIR:-/app/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIR"
  chown -R node:node "$DIR"
  chmod 700 "$DIR"
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all -- "$@"
fi
exec "$@"
