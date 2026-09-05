# WealthFlow BMS — Deployment (single source of truth)

> This file supersedes every other deploy guide and package folder in this repo.
> If you find `DEPLOYMENT_GUIDE.md`, `FINAL_*`, `deploy_*`, or any `*.zip` — they are
> **obsolete**. Do not use them.

## What actually runs in production

- Host: Hostinger (LiteSpeed Passenger), domain **nflx.in**.
- App root on server: `/home/u477139614/domains/nflx.in/nodejs/`
- **Backend entrypoint: `server.js`** (NOT `index.js` — `index.js` is retired/dead).
  - Verified live config: `public_html/.htaccess` → `PassengerStartupFile server.js`.
- Node: `/opt/alt/alt-nodejs22/root/bin/node` (Node 22). Not on PATH by default —
  for one-off scripts: `export PATH=/opt/alt/alt-nodejs22/root/usr/bin:$PATH`.
- Frontend (built SPA) is served from `nodejs/public/` (content-hashed bundles;
  `public/index.html` points at the active bundle).
- DB (MySQL) is reachable only from the server — run DB scripts over SSH.

## Frontend deploy

```bash
# 1. Build (from the Source Code/ app)
cd "Source Code" && npm run build        # tsc && vite build → Source Code/dist/

# 2. Upload bundles + index.html to the server's web root
scp -i ~/.ssh/hostinger_nflx_deploy -P 65002 dist/assets/* \
    u477139614@72.60.207.128:/home/u477139614/domains/nflx.in/nodejs/public/assets/
scp -i ~/.ssh/hostinger_nflx_deploy -P 65002 dist/index.html \
    u477139614@72.60.207.128:/home/u477139614/domains/nflx.in/nodejs/public/index.html

# 3. Restart + verify
ssh ... "touch /home/u477139614/domains/nflx.in/nodejs/tmp/restart.txt"
curl -s https://nflx.in/ | grep -oE 'assets/index-[A-Za-z0-9_.-]+\.js'   # new hash?
```

Always back up `public/index.html` on the server before overwriting
(e.g. `cp index.html index.html.bak-<change>`).

## Backend deploy (server.js)

```bash
# Edit server.js locally, then:
scp -i ~/.ssh/hostinger_nflx_deploy -P 65002 server.js \
    u477139614@72.60.207.128:/home/u477139614/domains/nflx.in/nodejs/server.js
ssh ... "touch /home/u477139614/domains/nflx.in/nodejs/tmp/restart.txt"
curl -s https://nflx.in/api/health    # expect {"status":"online","database":"connected",...}
```

`server.js` rejects a weak/missing `JWT_SECRET` at boot — if the app fails to come
back after a deploy, check the server `.env` JWT secret first.

## Secrets

Secrets live ONLY in the server's `.env` (and a local `.env` for dev — gitignored).
Never commit `.env` or copy it into deploy folders/zips. Rotate the MySQL password
and `JWT_SECRET` if they were ever committed.

## Backups

`backup_db.sh` (mysqldump). Confirm an hPanel cron runs it daily and that backups
are copied off the Hostinger account. Test a restore periodically.

## Automated deploy (GitHub Actions)

Repo: `AinaTech24/wealthflow-bms` (private). Two workflows run the steps above for you.

| Workflow | Triggers on push to `main` touching | What it does |
|---|---|---|
| `.github/workflows/deploy-frontend.yml` | `Source Code/**` | `npm ci` + `npm run build`, backs up live `public/index.html`, scps `dist/assets/*` + `dist/index.html`, restarts, verifies the live bundle hash |
| `.github/workflows/deploy-backend.yml` | `server.js`, `src/**`, `package*.json`, `.htaccess` | backs up live `server.js`, scps `server.js` + `src/`, restarts, asserts `/api/health` reports `"database":"connected"` |

Both also run on demand from the Actions tab (`workflow_dispatch`). Each keeps the
last 5 CI backups on the server (`server.js.bak-ci-*`, `index.html.bak-ci-*`).

**Required secret:** `SSH_PRIVATE_KEY` — the contents of `~/.ssh/hostinger_nflx_deploy`.
Host/port/user/path are plain `env:` in the workflow files (same values as above).

```bash
gh secret set SSH_PRIVATE_KEY --repo AinaTech24/wealthflow-bms < ~/.ssh/hostinger_nflx_deploy
```

**Dependency changes are NOT automated.** If `package.json` changes, the backend
workflow only warns — run `npm install --omit=dev` on the server yourself (native
deps like `bcrypt` and `canvas` must build against the host's Node 22).
