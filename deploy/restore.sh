#!/usr/bin/env bash
# Restore from a backup pair. DESTRUCTIVE — overwrites the live DB + storage.
#   ./deploy/restore.sh backups/db-<stamp>.sql.gz backups/storage-<stamp>.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."

DB_DUMP=${1:?usage: restore.sh <db.sql.gz> <storage.tar.gz>}
STORAGE_TAR=${2:?usage: restore.sh <db.sql.gz> <storage.tar.gz>}
ENV_FILE=deploy/.env.prod
set -a; . "$ENV_FILE"; set +a
COMPOSE="docker compose --env-file $ENV_FILE -f docker-compose.prod.yml"

read -r -p "This OVERWRITES the live database and storage. Type 'yes' to continue: " ok
[ "$ok" = "yes" ] || { echo "Aborted."; exit 1; }

echo "[1/2] Restoring database…"
gunzip -c "$DB_DUMP" | $COMPOSE exec -T mysql sh -c "exec mysql -uroot -p\"$MYSQL_ROOT_PASSWORD\""

echo "[2/2] Restoring object storage…"
docker run --rm \
  -v livetich_storage:/data \
  -v "$(pwd)/$(dirname "$STORAGE_TAR")":/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/$(basename "$STORAGE_TAR") -C /data"

echo "Restore complete. Restarting API…"
$COMPOSE restart api
