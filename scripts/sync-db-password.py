#!/usr/bin/env python3
"""Keeps the app's database password in step with AWS Secrets Manager.

RDS rotates the master password every 7 days and writes the new one to a secret.
The app reads DB_PASSWORD from .env, so after a rotation every NEW database
connection is refused until .env is updated. This closes that gap by itself.

Run by wealthflow-db-sync.timer every minute, as the `ubuntu` user. Each run:

  1. reads the current password from the secret (the EC2 role may read that one
     secret and nothing else),
  2. does nothing if it equals the password in .env,
  3. otherwise TESTS the new password against the database first, and leaves
     everything alone if it does not work yet (a rotation is not instantaneous,
     so the next run tries again),
  4. rewrites .env atomically, restarts the app, and waits for /api/health to
     report a connected database.

The password is never printed or logged.
Usage: sync-db-password.py [--dry-run]
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

APP_DIR = os.environ.get("WF_APP_DIR", "/home/ubuntu/wealthflow")
ENV_PATH = os.path.join(APP_DIR, ".env")
REGION = os.environ.get("AWS_REGION", "ap-south-1")
HEALTH_URL = "http://127.0.0.1:3000/api/health"
DRY_RUN = "--dry-run" in sys.argv


def log(msg):
    print(msg, flush=True)


def read_env():
    values = {}
    with open(ENV_PATH) as f:
        for line in f:
            m = re.match(r'^([A-Z0-9_]+)=(.*)$', line.rstrip("\n"))
            if m:
                v = m.group(2)
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                values[m.group(1)] = v
    return values


def secret_password(secret_id):
    out = subprocess.run(
        ["aws", "secretsmanager", "get-secret-value", "--region", REGION,
         "--secret-id", secret_id, "--query", "SecretString", "--output", "text"],
        capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError("could not read the secret: " + out.stderr.strip().splitlines()[-1][:200])
    return json.loads(out.stdout)["password"]


def db_accepts(env, password):
    cmd = ["mariadb", "-h", env["DB_HOST"], "-P", env.get("DB_PORT", "3306"),
           "-u", env["DB_USER"], "--connect-timeout=8", "-N", "-e", "SELECT 1"]
    if env.get("DB_SSL_CA"):
        cmd[1:1] = ["--ssl", "--ssl-ca=" + env["DB_SSL_CA"]]
    r = subprocess.run(cmd, env={**os.environ, "MYSQL_PWD": password},
                       capture_output=True, text=True, timeout=30)
    return r.returncode == 0


def write_env(password):
    with open(ENV_PATH) as f:
        text = f.read()
    new_line = 'DB_PASSWORD="' + password + '"'
    if re.search(r"(?m)^DB_PASSWORD=.*$", text):
        text = re.sub(r"(?m)^DB_PASSWORD=.*$", lambda _: new_line, text)
    else:
        text += "\n" + new_line + "\n"
    fd, tmp = tempfile.mkstemp(dir=APP_DIR, prefix=".env.")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, ENV_PATH)          # atomic: the app never sees a half-written file


def healthy(tries=20):
    for _ in range(tries):
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=5) as r:
                if '"database":"connected"' in r.read().decode():
                    return True
        except Exception:
            pass
        time.sleep(2)
    return False


def main():
    env = read_env()
    secret_id = env.get("DB_SECRET_ARN")
    if not secret_id:
        log("DB_SECRET_ARN is not set in .env; nothing to sync")
        return 2

    new = secret_password(secret_id)
    if new == env.get("DB_PASSWORD", ""):
        return 0                                  # the common case: nothing to do

    log("The secret holds a different password from .env")
    if not db_accepts(env, new):
        log("The new password is not accepted by the database yet; leaving .env alone, will retry")
        return 1
    if DRY_RUN:
        log("DRY RUN: new password works; would update .env and restart the app")
        return 0

    write_env(new)
    log(".env updated with the new password")
    subprocess.run(["pm2", "restart", "wealthflow"], check=True, capture_output=True, timeout=60)
    if healthy():
        log("App restarted and connected to the database with the new password")
        return 0
    log("ERROR: app restarted but the database check still fails; look at `pm2 logs wealthflow`")
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:                          # never leak a password via a traceback
        log("ERROR: " + type(e).__name__ + ": " + str(e)[:200])
        sys.exit(1)
