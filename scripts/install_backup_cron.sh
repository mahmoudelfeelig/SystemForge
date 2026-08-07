#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
MARKER="# systemforge-postgres-backup"
ENTRY="17 2 * * * SYSTEMFORGE_APP_DIR=$APP_DIR $APP_DIR/scripts/backup_postgres.sh >> /opt/systemforge-backups/backup.log 2>&1 $MARKER"
TEMP=$(mktemp)
trap 'rm -f "$TEMP"' EXIT HUP INT TERM
crontab -l 2>/dev/null | grep -vF "$MARKER" > "$TEMP" || true
printf '%s\n' "$ENTRY" >> "$TEMP"
crontab "$TEMP"
echo "Installed nightly SystemForge PostgreSQL backup schedule."
