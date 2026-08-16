#!/usr/bin/env bash
# Nightly backup: MySQL dump + object-storage tarball, rotated after RETAIN_DAYS.
# Run from the livetich-api repo root:  ./deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=deploy/.env.prod
set -a; . "$ENV_FILE"; set +a

BACKUP_DIR=${BACKUP_DIR:-./backups}
RETAIN_DAYS=${RETAIN_DAYS:-14}
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"
COMPOSE="docker compose --env-file $ENV_FILE -f docker-compose.prod.yml"

echo "[1/3] Dumping database…"
$COMPOSE exec -T mysql sh -c \
  "exec mysqldump -uroot -p\"$MYSQL_ROOT_PASSWORD\" --single-transaction --routines --databases $MYSQL_DATABASE" \
  | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"

echo "[2/3] Archiving object storage…"
docker run --rm \
  -v livetich_storage:/data:ro \
  -v "$(pwd)/$BACKUP_DIR":/backup \
  alpine tar czf "/backup/storage-$STAMP.tar.gz" -C /data .

echo "[3/3] Rotating backups older than ${RETAIN_DAYS}d…"
find "$BACKUP_DIR" -name 'db-*.sql.gz' -mtime +"$RETAIN_DAYS" -delete
find "$BACKUP_DIR" -name 'storage-*.tar.gz' -mtime +"$RETAIN_DAYS" -delete

echo "Done → $BACKUP_DIR/db-$STAMP.sql.gz  +  storage-$STAMP.tar.gz"
