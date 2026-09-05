#!/bin/bash
# Freedom LifeX — DB backup. Usage: backup_db.sh [label]   (label: daily|snapshot|manual)
set -euo pipefail

APP="$HOME/domains/nflx.in/nodejs"
ENVFILE="$APP/.env"
BK="$HOME/backups"
mkdir -p "$BK"

val() { grep -E "^$1=" "$ENVFILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r" ' || true; }
DB_HOST="$(val DB_HOST)"; DB_USER="$(val DB_USER)"; DB_PASS="$(val DB_PASSWORD)"
DB_NAME="$(val DB_NAME)"; DB_PORT="$(val DB_PORT)"; DB_PORT="${DB_PORT:-3306}"

if [ -z "$DB_HOST" ] || [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
  echo "[backup] ERROR: DB creds missing from $ENVFILE" >&2; exit 1
fi

# Credentials via temp file so the password never shows in `ps`.
CNF="$(mktemp)"; chmod 600 "$CNF"
printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' "$DB_HOST" "$DB_PORT" "$DB_USER" "$DB_PASS" > "$CNF"
trap 'rm -f "$CNF"' EXIT

LABEL="${1:-daily}"
TS="$(date +%Y%m%d_%H%M%S)"
OUT="$BK/nflx_${LABEL}_${TS}.sql.gz"

mysqldump --defaults-extra-file="$CNF" --single-transaction --quick --no-tablespaces \
  --routines --events "$DB_NAME" | gzip > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] $(date '+%F %T') wrote $OUT ($SIZE)"

# Rotation: keep last 14 daily, last 10 snapshots, last 10 manual. Never fatal.
set +e
ls -1t "$BK"/nflx_daily_*.sql.gz    2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$BK"/nflx_snapshot_*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
ls -1t "$BK"/nflx_manual_*.sql.gz   2>/dev/null | tail -n +11 | xargs -r rm -f
exit 0
