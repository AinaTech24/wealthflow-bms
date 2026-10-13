# Testing locally before you push

Run the whole app on your own computer, against a **private test database filled with
fake data**. Nothing here touches nflx.in, AWS or any real client.

## One-time setup

1. A local MariaDB or MySQL on this computer. Here it listens on `127.0.0.1:3307`.
2. In it, create an empty database `wealthflow_local` and a user that can use only that
   database (never `SUPER`):
   ```sql
   CREATE DATABASE wealthflow_local CHARACTER SET utf8mb4;
   CREATE USER 'wf_local'@'127.0.0.1' IDENTIFIED BY '<choose-a-password>';
   GRANT ALL ON wealthflow_local.* TO 'wf_local'@'127.0.0.1';
   ```
3. A local-only `.env` in the project root (it is git-ignored; never put it on a server):
   ```
   NODE_ENV=development
   PORT=3000
   DB_HOST=127.0.0.1
   DB_PORT=3307
   DB_USER=wf_local
   DB_PASSWORD=<the password above>
   DB_NAME=wealthflow_local
   JWT_SECRET=<48+ random characters>
   ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
   ```
4. `npm ci` in the project root and in `Source Code/` (then `npm rebuild bcrypt` if the
   password library complains).

## Start it

Three terminals (or three background jobs), from the project root:

```bash
node server.js                        # backend on :3000; creates the tables on first start
cd "Source Code" && npm run dev       # frontend on :5173
```

Fill the fake book (safe to repeat: it empties the test tables first, and **refuses to run
unless the database is local and named `wealthflow_local`**), then calculate every payout:

```bash
node tools/localSeed.mjs
node tools/localAddMonth.mjs 2026-09      # one more month, like importing next month's RTA file
node recalcRun.js
```

Open **http://localhost:5173**. The test logins are listed at the top of
`tools/localSeed.mjs`.

## What to check, and what you should see

Numbers are from a clean seed (June to September 2026, nothing locked).

**1. Finance dashboard** (finance login). "Payout Summary" opens on September. Switch Month
to August: earned **₹1,12,404.45** (mutual fund ₹1,01,640.45 + Motilal ₹10,764). Product
"Motilal Oswal" shows ₹10,764. Year, Quarter and All work.

**2. BM and RM dashboards** (bm / rm login). "My earnings by month" at the top shows only that
person. Alpha BM, September: **₹39,743.70**.

**3. Lock months** (admin, Admin Console > System > Lock months). Choose Aug 2026 and lock:
June, July and August show "Locked". A Recalculate afterwards changes only September.

**4. Promotion** (admin, Clients & Map > Hierarchy > Shakeel > edit). Pick "September 2026
onward" and Level 3. A panel appears: **5 clients will move, 2 have Yash Manager at Level 3
already**. Save & Recalculate. Then:
- August payouts are exactly what they were (Shakeel ₹10,799.25).
- His 5 clients now sit at L3; the 2 under Yash are untouched.
- Admin Console > Activity Log shows the move "from 2026-09".

**5. L5 and L6 (paid from the company's share).** In Global Rules set Level 5 to 5% and
Level 6 to 5%, save, Recalculate. September: Gamma Senior (L5) **₹6,033.75** and System Corp
(L6) **₹6,033.75** (5% of ₹1,20,675 each); every RM and BM figure is exactly as before
(Alpha BM ₹39,743.70); the total paid out goes from 85% to **95%**, because the 10% came
out of the company's 15%, not out of anyone's share. Set both back to 0 and Recalculate to
return to 85%.

**6. Undo.** Edit Shakeel again, Level 2, "September 2026 onward". His clients return to L2,
his September goes back to ₹9,438.75 and no history is left behind.

**7. Replace.** Edit Bhavna RM to Level 4, September, choose "Put Bhavna at Level 4 on those
clients too". Her September now includes the L4 remainder on those clients; Beta BM's
drops; August stays as it was.

## Reset to a clean state

```bash
node tools/localSeed.mjs && node tools/localAddMonth.mjs 2026-09 && node recalcRun.js
```
then restart `node server.js` (it keeps some figures in memory).

## When it all looks right

`npm test` (24 suites) and `cd "Source Code" && npx tsc --noEmit` must pass, then push. The
GitHub workflow repeats both and deploys; if the new version cannot reach the database the
server puts the previous one back by itself.
