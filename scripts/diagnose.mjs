/**
 * READ-ONLY reconciliation diagnostic. Runs ON the AWS server, from
 * .github/workflows/diagnose.yml, and prints to the Actions log.
 *
 * It exists because the EC2 key is a GitHub secret — write-only by design — so
 * nobody's workstation can reach the database to answer "which investor is the
 * ₹35 under MSA?". A workflow can, using the same secret the deploy uses,
 * without the key ever leaving GitHub.
 *
 * Every statement here is a SELECT. It changes nothing.
 *
 *   node scripts/diagnose.mjs 2026-08
 */
import '../bootstrap-env.js';
import pool from '../src/lib/db.js';
import { nameContradicts } from '../src/lib/nameMatch.js';

const PERIOD = process.argv[2] || '2026-08';
const inr = (n) => Number(n || 0).toFixed(2);
const line = (s = '') => console.log(s);

const [team] = await pool.query('SELECT id, name, level, parentId FROM team');
const [clients] = await pool.query('SELECT id, name, data FROM clients');

const hier = new Map(), cname = new Map(), folios = new Map();
for (const c of clients) {
  let d = {}; try { d = JSON.parse(c.data || '{}'); } catch {}
  hier.set(c.id, d.hierarchy || {});
  cname.set(c.id, (c.name || '').trim());
  for (const f of (Array.isArray(d.folios) ? d.folios : [])) {
    const k = String(f).trim(); if (!k) continue;
    if (!folios.has(k)) folios.set(k, []);
    folios.get(k).push(c.id);
  }
}

const grossFor = async (ids) => {
  if (!ids.length) return 0;
  let total = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const ch = ids.slice(i, i + 500);
    const [[r]] = await pool.query(
      `SELECT ROUND(SUM(grossAmount),2) v FROM transactions
        WHERE brokeragePeriod=? AND mappedClientId IN (${ch.map(() => '?').join(',')})`, [PERIOD, ...ch]);
    total += Number(r.v || 0);
  }
  return total;
};

line(`\n================ WealthFlow diagnostic — ${PERIOD} ================`);

// 1. The whole month, and what never reaches a person.
const [[tot]] = await pool.query(
  'SELECT COUNT(*) n, ROUND(SUM(grossAmount),2) g FROM transactions WHERE brokeragePeriod=?', [PERIOD]);
const [[un]] = await pool.query(
  `SELECT COUNT(*) n, ROUND(SUM(grossAmount),2) g FROM transactions
    WHERE brokeragePeriod=? AND (mappedClientId IS NULL OR mappedClientId='')`, [PERIOD]);
line(`\nMonth total      : ${tot.n} rows, Rs ${inr(tot.g)}`);
line(`Attached to NO client : ${un.n} rows, Rs ${inr(un.g)}`);

const [perClient] = await pool.query(
  `SELECT mappedClientId cid, ROUND(SUM(grossAmount),2) v FROM transactions
    WHERE brokeragePeriod=? AND mappedClientId IS NOT NULL AND mappedClientId<>'' GROUP BY 1`, [PERIOD]);
let noRmRows = 0, noRmGross = 0;
const noRmTop = [];
for (const r of perClient) {
  if (!(hier.get(r.cid) || {}).level3Id) {
    noRmRows++; noRmGross += Number(r.v || 0);
    noRmTop.push({ name: cname.get(r.cid) || r.cid, v: Number(r.v || 0) });
  }
}
noRmTop.sort((a, b) => b.v - a.v);
line(`Client but NO RM at L3: ${noRmRows} clients, Rs ${inr(noRmGross)}`);
for (const x of noRmTop.slice(0, 15)) line(`     ${inr(x.v).padStart(10)}  ${x.name}`);

// 2. Per RM (level 3) and per BM (own book + everyone reporting to them).
const byName = (nm, lv) => team.filter(t => (t.name || '').trim().toUpperCase() === nm.toUpperCase() && t.level === lv);
const clientsOfSlot = (id, lv) => [...hier].filter(([, h]) => h[`level${lv}Id`] === id).map(([cid]) => cid);

line('\n---- RM (L3): WealthFlow gross ----');
for (const nm of ['FIDHANTA ASSET SERVICES LLP', 'Finowise Varanasi', 'Mahek Haresh Chugh',
                  'MSA Financial Services', 'RAVISANKAR  K K', 'Vinubhai Nathubhai Desai']) {
  let v = 0, n = 0;
  for (const p of byName(nm, 3)) { const ids = clientsOfSlot(p.id, 3); n += ids.length; v += await grossFor(ids); }
  line(`  ${nm.padEnd(34)} ${inr(v).padStart(12)}   (${n} clients)`);
}

line('\n---- BM (L4): own book + everyone reporting to them ----');
for (const nm of ['KUMARESH B S', 'MSA FINANCIAL SERVICES LLP', 'PRAVEEN VERMA', 'PREM MANGTANI',
                  'VARALAXMI WEALTH PRIVATE LIMITED', 'VEER WEALTH PRIVATE LIMITED', 'WEALTH NEST SIP ADVISORY PVT LTD']) {
  for (const bm of byName(nm, 4)) {
    let v = await grossFor(clientsOfSlot(bm.id, 4));
    const parts = [];
    for (const kid of team.filter(t => t.parentId === bm.id)) {
      const ids = [...hier].filter(([, h]) => Object.values(h).includes(kid.id)).map(([cid]) => cid);
      const kv = await grossFor(ids);
      if (kv) parts.push(`${(kid.name || '').trim()} ${inr(kv)}`);
      v += kv;
    }
    line(`  ${nm.padEnd(34)} ${inr(v).padStart(12)}${parts.length ? '   = own + ' + parts.join(' + ') : ''}`);
  }
}

// 3. Rows whose investor name disagrees with the client they are attached to.
line('\n---- Rows whose investor name disagrees with their client ----');
const [mism] = await pool.query(
  `SELECT mappedClientId cid, investorName inv, COUNT(*) n, ROUND(SUM(grossAmount),2) v
     FROM transactions WHERE brokeragePeriod=? AND mappedClientId IS NOT NULL AND mappedClientId<>''
    GROUP BY 1,2`, [PERIOD]);
const bad = mism.filter(r => nameContradicts(cname.get(r.cid) || '', r.inv || ''));
bad.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
line(`  ${bad.length} group(s), Rs ${inr(bad.reduce((a, x) => a + Number(x.v), 0))}`);
for (const r of bad.slice(0, 20)) {
  const h = hier.get(r.cid) || {};
  const rm = team.find(t => t.id === h.level3Id);
  line(`   ${inr(r.v).padStart(9)} ${String(r.n).padStart(4)}tx | record "${(cname.get(r.cid) || '').slice(0, 28)}" | file "${String(r.inv).trim().slice(0, 28)}" | RM ${(rm?.name || '-').trim()}`);
}

// 4. Folios claimed by more than one client — the ambiguity the importer must resolve.
const conflicted = [...folios.entries()].filter(([, l]) => l.length > 1);
line(`\n---- Folio ownership ----`);
line(`  ${folios.size} folios on client records; ${conflicted.length} claimed by more than one client`);
const worst = conflicted.sort((a, b) => b[1].length - a[1].length).slice(0, 5);
for (const [f, l] of worst) line(`   folio ${String(f).padEnd(20)} claimed by ${l.length} records`);

line('\n================ end ================\n');
process.exit(0);
