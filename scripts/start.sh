#!/bin/sh
# Container entrypoint. With Litestream configured: restore the DB from the replica if the
# volume is empty (new machine, lost volume), then run the app under `litestream replicate`.
# Without it: just run the app.
set -e

if [ -n "$LITESTREAM_BUCKET" ]; then
  mkdir -p "$(dirname "$DB_PATH")"
  litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$DB_PATH"
  exec litestream replicate -config /etc/litestream.yml -exec "bun src/index.ts"
fi

echo "LITESTREAM_BUCKET not set: running without continuous backup"
exec bun src/index.ts
