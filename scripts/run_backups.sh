#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:?SYSTEMFORGE_APP_DIR is required}
BACKUP_DIR=${SYSTEMFORGE_BACKUP_DIR:?SYSTEMFORGE_BACKUP_DIR is required}
CONFIG_FILE=${SYSTEMFORGE_OFFSITE_CONFIG:-"$BACKUP_DIR/.offsite/offsite-backup.env"}

SYSTEMFORGE_APP_DIR="$APP_DIR" "$APP_DIR/scripts/backup_postgres.sh"
if test -f "$CONFIG_FILE"; then
  SYSTEMFORGE_APP_DIR="$APP_DIR" \
    SYSTEMFORGE_OFFSITE_CONFIG="$CONFIG_FILE" \
    "$APP_DIR/scripts/backup_offsite.sh"
else
  echo "Off-site backup is not configured; the verified same-host dump remains available."
fi
