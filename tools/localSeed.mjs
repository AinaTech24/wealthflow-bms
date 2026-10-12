/**
 * Fill a LOCAL test database with a small, FAKE book so the payout, promotion, lock
 * and earnings screens can be tried safely before anything is deployed.
 *
 *   1. point .env at the local test database (DB_HOST=127.0.0.1, DB_NAME=wealthflow_local)
 *   2. start the app once (node server.js) so it creates the tables
 *   3. node tools/localSeed.mjs          # fills it, then
 *   4. node recalcRun.js                 # calculates every payout
 *
 * SAFETY: it refuses to run unless the database is on this computer AND is named
 * wealthflow_local, and it empties the tables it fills. It can never touch production.
 *
 * TEST LOGINS (local test data only; log in at http://localhost:5173)
 *   password for every account below:  LocalTest#2026
 *   admin@local.test      Admin   (all screens, Admin Console, Lock months, promotions)
 *   finance@local.test    Finance (Payout Summary dashboard, Payouts page)
 *   bm@local.test         BM at L4 (Alpha BM): sees "My earnings by month"
 *   rm@local.test         RM at L3 (Anil)
 *   shakeel@local.test    RM at L2: the person to promote to L3 in the promotion test
 *
 * THE FAKE BOOK
 *   Chain: House (L7) > System Corp (L6) > Gamma Senior (L5) > Alpha BM / Beta BM (L4)
 *          > Yash Manager / Anil RM (L3, under Alpha) and Bhavna RM (L3, under Beta)
 *          > Shakeel (L2, under Alpha) and Priya (L2, under Beta)
 *   Shakeel has 7 clients: 5 with no L3 above him (they move up on their own) and 2
 *   that sit under Yash at L3 (the "someone is already there" case).
 *   Months June, July and August 2026, all open (nothing locked), so the lock step can
 *   be tried from the start. Motilal Oswal (MOFSL) rows for August.
 *   Rates are the live configuration: company 15%, L1-L3 25%, lead bonus 25%, residual L4.
 */
import './../bootstrap-env.js';
import bcrypt from 'bcrypt';
import pool from '../src/lib/db.js';

// ── safety lock ──────────────────────────────────────────────────────────────────
const host = String(process.env.DB_HOST || '');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) || process.env.DB_NAME !== 'wealthflow_local') {
  console.error(`REFUSING TO RUN: this only fills a local database named wealthflow_local (DB_HOST=${host}, DB_NAME=${process.env.DB_NAME}).`);
  process.exit(1);
}

const TEST_PASSWORD = 'LocalTest#2026';
const hash = await bcrypt.hash(TEST_PASSWORD, 10);
const PERIODS = ['2026-06', '2026-07', '2026-08'];

// ── team ─────────────────────────────────────────────────────────────────────────
const team = [
  ['u_house',   null,       'Freedom Lifex (House)', 'HOUSE', 'OPS',     7, 'house@local.test'],
  ['u_sys',     'u_house',  'System Corp',           'SYS',   'OPS',     6, 'sys@local.test'],
  ['u_senior',  'u_sys',    'Gamma Senior',          'SEN',   'OPS',     5, 'senior@local.test'],
  ['u_bm1',     'u_senior', 'Alpha BM',              'BM1',   'OPS',     4, 'bm@local.test'],
  ['u_bm2',     'u_senior', 'Beta BM',               'BM2',   'OPS',     4, 'bm2@local.test'],
  ['u_yash',    'u_bm1',    'Yash Manager',          'YASH',  'OPS',     3, 'yash@local.test'],
  ['u_anil',    'u_bm1',    'Anil RM',               'ANIL',  'OPS',     3, 'rm@local.test'],
  ['u_bhavna',  'u_bm2',    'Bhavna RM',             'BHAV',  'OPS',     3, 'bhavna@local.test'],
  ['u_shakeel', 'u_bm1',    'Shakeel Test',          'SHAK',  'OPS',     2, 'shakeel@local.test'],
  ['u_priya',   'u_bm2',    'Priya Test',            'PRIY',  'OPS',     2, 'priya@local.test'],
  ['u_admin',   null,       'Local Admin',           'ADMIN', 'ADMIN',   7, 'admin@local.test'],
  ['u_fin',     null,       'Local Finance',         'FIN',   'FINANCE', 7, 'finance@local.test'],
];

// ── clients ──────────────────────────────────────────────────────────────────────
const upper = (bm) => ({ level4Id: bm, level5Id: 'u_senior', level6Id: 'u_sys', level7Id: 'u_house' });
const clients = [];
const add = (id, name, hierarchy, leadSourceLevel) => clients.push({ id, name, hierarchy, leadSourceLevel });
for (let i = 1; i <= 5; i++) add(`c_s0${i}`, `Shakeel Free Client ${i}`, { level2Id: 'u_shakeel', ...upper('u_bm1') });
for (let i = 1; i <= 2; i++) add(`c_m0${i}`, `Shakeel Managed Client ${i}`, { level2Id: 'u_shakeel', level3Id: 'u_yash', ...upper('u_bm1') });
for (let i = 1; i <= 5; i++) add(`c_p0${i}`, `Priya Client ${i}`, { level2Id: 'u_priya', ...upper('u_bm2') });
for (let i = 1; i <= 6; i++) add(`c_a0${i}`, `Anil Client ${i}`, { level3Id: 'u_anil', ...upper('u_bm1') }, i <= 2 ? 3 : undefined);
for (let i = 1; i <= 4; i++) add(`c_b0${i}`, `Bhavna Client ${i}`, { level3Id: 'u_bhavna', ...upper('u_bm2') });

// ── config: the live rules ───────────────────────────────────────────────────────
const config = {
  id: 'global', name: 'Standard Payout Rules', scope: 'GLOBAL',   // must equal the table row id, or a save creates a second row
  companyExpensePct: 15, leadSharingModel: 'RESIDUAL', leadSourcePct: 25, residualLevel: 4,
  levels: { 0: 20, 1: 25, 2: 25, 3: 25, 4: 5, 5: 0, 6: 0, 7: 0 },
  levelNames: { 7: 'Freedom Lifex', 6: 'Corporate', 5: 'Senior', 4: 'Branch Manager', 3: 'RM L3', 2: 'RM L2', 1: 'RM L1' },
  lockedPeriods: [],
  defaultGstRate: 18, defaultTdsRate: 2,
  partnerSharing: { MOFSL: { 2: 10, 3: 10, 4: 30 } },
};

// ── write ────────────────────────────────────────────────────────────────────────
for (const t of ['team', 'clients', 'transactions', 'batches', 'config', 'payout_ledger', 'payout_settlements', 'partner_brokerage', 'partner_client_map', 'invoices', 'activity_log']) {
  await pool.query(`DELETE FROM ${t}`);
}

for (const [id, parentId, name, code, role, level, email] of team) {
  await pool.query('INSERT INTO team (id, parentId, name, code, role, level, email, password, data) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, parentId, name, code, role, level, email, hash, JSON.stringify({ customLevels: {} })]);
}
let n = 0;
for (const c of clients) {
  const pan = `TEST${String.fromCharCode(65 + (n % 26))}${String(1000 + n).padStart(4, '0')}${String.fromCharCode(65 + ((n * 7) % 26))}`;
  const folio = `99${String(100000 + n)}`;
  const data = { id: c.id, name: c.name, pan, folios: [folio], hierarchy: c.hierarchy, ...(c.leadSourceLevel ? { leadSourceLevel: c.leadSourceLevel } : {}), updatedAt: new Date().toISOString() };
  await pool.query('INSERT INTO clients (id, primaryOwnerId, pan, name, data) VALUES (?,?,?,?,?)', [c.id, null, pan, c.name, JSON.stringify(data)]);
  c.pan = pan; c.folio = folio; n++;
}
// Real imports store their size and total, and the notification bell prints both.
for (const [i, p] of PERIODS.entries()) {
  const rowsInMonth = clients.length * 3;
  const grossInMonth = Math.round(clients.reduce((a, c, idx) => a + [1, 2, 3].reduce((b, k) => b + (600 + ((idx * 137 + k * 311 + Number(p.slice(-2)) * 53) % 2400)), 0), 0) * 100) / 100;
  await pool.query('INSERT INTO batches (id, fileName, data) VALUES (?,?,?)',
    [`B_${p}`, `CAMS_${p}.csv`, JSON.stringify({ kind: 'brokerage', source: 'CAMS', brokeragePeriod: p, uploadDate: new Date(Date.now() - (3 - i) * 86400000).toISOString(), totalLines: rowsInMonth, totalGross: grossInMonth })]);
}
let tx = 0;
clients.forEach((c, idx) => {
  for (const p of PERIODS) {
    for (let k = 1; k <= 3; k++) {
      const gross = Math.round((600 + ((idx * 137 + k * 311 + Number(p.slice(-2)) * 53) % 2400)) * 100) / 100;
      const id = `TX_${c.id}_${p}_${k}`;
      const data = { source: 'CAMS', batchId: `B_${p}`, brokeragePeriod: p, folio: c.folio, mappedClientId: c.id, investorName: c.name, pan: c.pan,
        amcName: 'Test AMC', schemeName: 'Test Growth Fund', grossAmount: gross, transactionDate: `${p}-15` };
      tx++;
      c._rows = (c._rows || []).concat([[id, `B_${p}`, c.pan, c.name, `${p}-15`, 'Test AMC', 'Test Growth Fund', gross, p, c.id, JSON.stringify(data)]]);
    }
  }
});
for (const c of clients) {
  await pool.query('INSERT INTO transactions (id, batchId, pan, investorName, transactionDate, amcName, schemeName, grossAmount, brokeragePeriod, mappedClientId, data) VALUES ?', [c._rows]);
}
await pool.query('INSERT INTO config (id, data) VALUES (?,?)', ['global', JSON.stringify(config)]);

// Motilal Oswal rows for August, on clients of Anil, Priya and Shakeel.
await pool.query('INSERT INTO batches (id, fileName, data) VALUES (?,?,?)',
  ['PB_MOFSL_1', 'BrokerageSharing_test.csv', JSON.stringify({ partner: 'MOFSL', kind: 'partner_brokerage', rowCount: 9, uploadDate: new Date().toISOString(), totalLines: 9, totalGross: 40000 })]);
const pbClients = ['c_a01', 'c_a02', 'c_a03', 'c_p01', 'c_p02', 'c_s01', 'c_s02', 'c_b01', 'c_m01'];
for (const [i, cid] of pbClients.entries()) {
  const total = 3000 + i * 450, ours = Math.round(total * 0.6 * 100) / 100;
  await pool.query(
    `INSERT INTO partner_brokerage (id, partner, batchId, tradeDate, period, clientCode, segment, tradeCategory, totalBrokerage, ourShare, partnerShare, mappedClientId, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [`PB_${i}`, 'MOFSL', 'PB_MOFSL_1', '2026-08-12', '2026-08', `T${1000 + i}`, 'CASH', 'DELIVERY', total, ours, total - ours, cid, '{}']);
}

// A couple of payments already made, so "paid" and "still owed" have something to show.
await pool.query('INSERT INTO payout_settlements (id, source, period, userId, amount, paidOn, method, createdBy) VALUES (?,?,?,?,?,CURDATE(),?,?)',
  ['PS_TEST_1', 'MF', '2026-07', 'u_anil', 500, 'BANK', 'seed']);
await pool.query('INSERT INTO payout_settlements (id, source, period, userId, amount, paidOn, method, createdBy) VALUES (?,?,?,?,?,CURDATE(),?,?)',
  ['PS_TEST_2', 'MF', '2026-07', 'u_bm1', 1000, 'BANK', 'seed']);

console.log(`seeded: ${team.length} team, ${clients.length} clients, ${tx} transactions over ${PERIODS.join(', ')}, ${pbClients.length} Motilal rows`);
await pool.end();
