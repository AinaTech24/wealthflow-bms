#!/usr/bin/env bash
# Runs ON the AWS server, called by .github/workflows/deploy-aws.yml.
#
# Unpacks /tmp/release.tgz (committed code + the freshly built frontend) over the
# live app, reloads pm2, and checks the app actually talks to the database. If it
# does not, the previous code is put back and reloaded, so a bad push leaves the
# site on the last good version instead of down.
#
# The server's .env is never in the release (it is gitignored), so secrets and the
# DB connection stay exactly as they are on the box.
set -euo pipefail

APP=/home/ubuntu/wealthflow
RELEASE=/tmp/release.tgz
BACKUPS=/home/ubuntu/backups
KEEP=5
TS=$(date -u +%Y%m%d-%H%M%S)

[ -f "$RELEASE" ] || { echo "::error::$RELEASE not found"; exit 1; }
mkdir -p "$BACKUPS"

lock_hash() { sha256sum "$APP/package-lock.json" 2>/dev/null | cut -d' ' -f1; }

healthy() {
  for _ in $(seq 1 20); do
    if curl -fsS -m 5 http://127.0.0.1:3000/api/health | grep -q '"database":"connected"'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

echo "── 1. Backing up the running version"
tar -czf "$BACKUPS/app-$TS.tgz" -C "$APP" --exclude=./node_modules --exclude=./.env .
ls -1t "$BACKUPS"/app-*.tgz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "   saved $BACKUPS/app-$TS.tgz (keeping the last $KEEP)"

OLD_LOCK=$(lock_hash)

echo "── 2. Unpacking the new release"
# Hashed bundles from the previous build are replaced, not piled up.
rm -rf "$APP/public/assets"
tar -xzf "$RELEASE" -C "$APP"
NEW_LOCK=$(lock_hash)

if [ "$OLD_LOCK" != "$NEW_LOCK" ]; then
  echo "── 3. package-lock.json changed: installing dependencies"
  (cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
else
  echo "── 3. Dependencies unchanged"
fi

echo "── 4. Reloading the app"
pm2 reload wealthflow --update-env

echo "── 5. Health check"
if healthy; then
  rm -f "$RELEASE"
  echo "✅ Deployed. App is online and connected to the database."
  exit 0
fi

echo "::error::New version failed its health check. Rolling back to $TS backup."
pm2 logs wealthflow --lines 30 --nostream || true
rm -rf "$APP/public/assets"
tar -xzf "$BACKUPS/app-$TS.tgz" -C "$APP"
if [ "$OLD_LOCK" != "$NEW_LOCK" ]; then
  (cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
fi
pm2 reload wealthflow --update-env
if healthy; then
  echo "↩️  Rolled back. The previous version is live again."
else
  echo "::error::Rollback also failed the health check. Check the server now."
fi
exit 1
