#!/bin/sh
set -eu

APP_DIR=${SYSTEMFORGE_APP_DIR:-/opt/systemforge}
BACKUP_DIR=${SYSTEMFORGE_BACKUP_DIR:-/opt/systemforge-backups}
MARKER="# systemforge-postgres-backup"

safe_absolute_path() {
  VALUE=$1
  LABEL=$2
  case "$VALUE" in
    /*) ;;
    *) echo "$LABEL must be an absolute path." >&2; exit 64 ;;
  esac
  case "$VALUE" in
    *[!A-Za-z0-9_./-]*)
      echo "$LABEL contains characters that are unsafe in a crontab entry." >&2
      exit 64
      ;;
  esac
  test "$VALUE" != / || {
    echo "$LABEL is too broad." >&2
    exit 64
  }
}

safe_absolute_path "$APP_DIR" "SYSTEMFORGE_APP_DIR"
safe_absolute_path "$BACKUP_DIR" "SYSTEMFORGE_BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

ENTRY="17 2 * * * SYSTEMFORGE_APP_DIR=$APP_DIR SYSTEMFORGE_BACKUP_DIR=$BACKUP_DIR $APP_DIR/scripts/run_backups.sh >> $BACKUP_DIR/backup.log 2>&1 $MARKER"
TEMP=$(mktemp)
trap 'rm -f "$TEMP"' EXIT HUP INT TERM
crontab -l 2>/dev/null | grep -vF "$MARKER" > "$TEMP" || true
printf '%s\n' "$ENTRY" >> "$TEMP"
crontab "$TEMP"
echo "Installed nightly SystemForge PostgreSQL backup schedule."
