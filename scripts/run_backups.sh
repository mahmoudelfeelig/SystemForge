#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
BACKUP_DIR=${SYSTEMFORGE_BACKUP_DIR:-/opt/systemforge-backups}
CONFIG_FILE=${SYSTEMFORGE_OFFSITE_CONFIG:-"$BACKUP_DIR/.offsite/offsite-backup.env"}

SYSTEMFORGE_APP_DIR="$APP_DIR" "$APP_DIR/scripts/backup_postgres.sh"
if test -f "$CONFIG_FILE"; then
  SYSTEMFORGE_APP_DIR="$APP_DIR" \
    SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_FILE" \
    "$APP_DIR/scripts/backup_offsite.sh"
else
  echo "Off-site backup is not configured; the verified same-host dump remains available."
fi
