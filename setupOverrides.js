// Enable manager (L4+) overrides, settable per-manager in the UI.
//  1. Reduce every team member's customLevels to their OWN level only, so each
//     level is self-driven (a manager's own % drives their override, not the RM's).
//     Managers (L4/L5/L6/L7) are reset to 0 (clean slate — user sets in the app).
//     RMs/L1/L2 keep their own-level rate.
//  2. Populate each client's upline slots (level4Id..level7Id) from the org chart
//     (walk the owning user's parent chain), so managers have downline to earn on.
// Dry-run by default; --apply commits (writes backups first).
import './bootstrap-env.js';
import pool from './src/lib/db.js';
import fs from 'fs';

const APPLY = process.argv.includes('--apply');
const parse = d => { try { return JSON.parse(d || '{}'); } catch { return {}; } };

const [team] = await pool.query("SELECT id,name,level,parentId,data FROM team");
const byId = new Map(team.map(t => [t.id, t]));
const [clients] = await pool.query("SELECT id,data FROM clients");

// ── 1. team: reduce customLevels to own-level-only ───────────────────────
const teamUpdates = [];
let rmKept = 0, mgrReset = 0;
for (const t of team) {
  const d = parse(t.data);
  const cl = d.customLevels || {};
  const own = Number(t.level);
  const ownVal = own >= 4 ? 0 : (cl[own] !== undefined ? cl[own] : 0);
  if (own >= 4) mgrReset++; else rmKept++;
  const newCl = { [own]: ownVal };
  if (JSON.stringify(cl) !== JSON.stringify(newCl)) {
    d.customLevels = newCl;
    teamUpdates.push([t.id, JSON.stringify(d)]);
  }
}

// ── 2. clients: populate upline slots from org chart ─────────────────────
const clientUpdates = [];
let linked = 0, noOwner = 0; const sample = [];
for (const c of clients) {
  const d = parse(c.data);
  const h = { ...(d.hierarchy || {}) };
  let ownerId = null, ownerLevel = null;
  for (let l = 1; l <= 7; l++) { const u = h[`level${l}Id`]; if (u && byId.has(u)) { ownerId = u; ownerLevel = l; break; } }
  if (!ownerId) { noOwner++; continue; }
  const before = JSON.stringify(h);
  let p = byId.get(ownerId).parentId ? byId.get(byId.get(ownerId).parentId) : null;
  let hops = 0;
  while (p && hops < 10) {
    const lvl = Number(p.level);
    if (lvl > ownerLevel && lvl <= 7) h[`level${lvl}Id`] = p.id;
    p = p.parentId ? byId.get(p.parentId) : null;
    hops++;
  }
  if (JSON.stringify(h) !== before) {
    d.hierarchy = h; clientUpdates.push([c.id, JSON.stringify(d)]); linked++;
    if (sample.length < 4) sample.push(`${c.id}: L3=${byId.get(h.level3Id)?.name||'-'} L4=${byId.get(h.level4Id)?.name||'-'} L5=${byId.get(h.level5Id)?.name||'-'}`);
  }
}

console.log(`\n=== setupOverrides ${APPLY ? '(APPLY)' : '(DRY-RUN)'} ===`);
console.log(`team: ${teamUpdates.length} customLevels reduced (RMs/L1-2 keep rate: ~${rmKept}, managers L4+ reset to 0: ${mgrReset})`);
console.log(`clients: ${linked} upline chains populated | ${noOwner} without a resolvable owner (skipped)`);
console.log('sample linked clients:'); sample.forEach(s => console.log('  ' + s));

if (APPLY) {
  fs.writeFileSync(`overrides_backup_team_${Date.now()}.json`, JSON.stringify(team.map(t => ({ id: t.id, data: t.data }))));
  fs.writeFileSync(`overrides_backup_clients_${Date.now()}.json`, JSON.stringify(clients));
  for (const [id, data] of teamUpdates) await pool.query("UPDATE team SET data=? WHERE id=?", [data, id]);
  for (let i = 0; i < clientUpdates.length; i += 200) {
    const ch = clientUpdates.slice(i, i + 200);
    for (const [id, data] of ch) await pool.query("UPDATE clients SET data=? WHERE id=?", [data, id]);
  }
  console.log(`\n✅ APPLIED: ${teamUpdates.length} team + ${clientUpdates.length} client updates. Backups written.`);
}
process.exit(0);
