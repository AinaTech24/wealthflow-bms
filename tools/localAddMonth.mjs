/**
 * LOCAL TEST ONLY: add one more month of fake brokerage to the local test database,
 * the way an RTA file import would, so a promotion "from next month" can be tried.
 *
 *   node tools/localAddMonth.mjs 2026-09
 *
 * Same safety lock as localSeed.mjs: it refuses anything but wealthflow_local on this computer.
 */
import './../bootstrap-env.js';
import pool from '../src/lib/db.js';

const host = String(process.env.DB_HOST || '');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) || process.env.DB_NAME !== 'wealthflow_local') {
  console.error(`REFUSING TO RUN: local test database only (DB_HOST=${host}, DB_NAME=${process.env.DB_NAME}).`);
  process.exit(1);
}
const period = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(period || '')) { console.error('usage: node tools/localAddMonth.mjs YYYY-MM'); process.exit(1); }

const [clients] = await pool.query("SELECT id, pan, name, data FROM clients ORDER BY id");
const rows = [];
let gross = 0;
clients.forEach((c, idx) => {
  const d = JSON.parse(c.data);
  for (let k = 1; k <= 3; k++) {
    const g = Math.round((600 + ((idx * 137 + k * 311 + Number(period.slice(-2)) * 53) % 2400)) * 100) / 100;
    gross += g;
    const id = `TX_${c.id}_${period}_${k}`;
    const data = { source: 'CAMS', batchId: `B_${period}`, brokeragePeriod: period, folio: d.folios[0], mappedClientId: c.id, investorName: c.name, pan: c.pan,
      amcName: 'Test AMC', schemeName: 'Test Growth Fund', grossAmount: g, transactionDate: `${period}-15` };
    rows.push([id, `B_${period}`, c.pan, c.name, `${period}-15`, 'Test AMC', 'Test Growth Fund', g, period, c.id, JSON.stringify(data)]);
  }
});
await pool.query('DELETE FROM transactions WHERE brokeragePeriod = ?', [period]);
await pool.query('DELETE FROM batches WHERE id = ?', [`B_${period}`]);
await pool.query('INSERT INTO batches (id, fileName, data) VALUES (?,?,?)',
  [`B_${period}`, `CAMS_${period}.csv`, JSON.stringify({ kind: 'brokerage', source: 'CAMS', brokeragePeriod: period, uploadDate: new Date().toISOString(), totalLines: rows.length, totalGross: Math.round(gross * 100) / 100 })]);
for (let i = 0; i < rows.length; i += 100) {
  await pool.query('INSERT INTO transactions (id, batchId, pan, investorName, transactionDate, amcName, schemeName, grossAmount, brokeragePeriod, mappedClientId, data) VALUES ?', [rows.slice(i, i + 100)]);
}
console.log(`added ${rows.length} transactions for ${period} (₹${gross.toFixed(2)} brokerage). Now run Recalculate (Admin Console > System) or: node recalcRun.js`);
await pool.end();
