// READ-ONLY. Two reports:
//   1. Remaining RM-ownership conflicts (current owner ≠ Excel RM) with detail.
//   2. Duplicate team records (same name, ≥2 ids) with usage counts across
//      clients (primaryOwnerId + every hierarchy level), payout_ledger, and
//      team.parentId — to choose a canonical record per RM before merging.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.resolve(__dirname, '../../investor_mapping.json');
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const parse = raw => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };
const SHEET_RM_OVERRIDES = { 'sarvottam wealthnetwork private': 'tm_1769496581772' };

async function main() {
  const mapping = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
  const [teamRows] = await pool.query('SELECT id, name, level, parentId FROM team');
  const teamById = new Map(), teamByName = new Map();
  for (const t of teamRows) {
    teamById.set(t.id, t);
    const k = norm(t.name); const prev = teamByName.get(k);
    if (!prev || (t.level === 1 && prev.level !== 1)) teamByName.set(k, t);
  }
  const [clientRows] = await pool.query('SELECT id, primaryOwnerId, name, data FROM clients');
  const clientsByName = new Map();
  for (const c of clientRows) {
    const k = norm(c.name);
    (clientsByName.get(k) || clientsByName.set(k, []).get(k)).push(c);
  }

  // ── Report 1: remaining conflicts ──────────────────────────────────────────
  const conflicts = []; const seen = new Set();
  for (const sheet of mapping.rms) {
    const oid = SHEET_RM_OVERRIDES[norm(sheet.rmSheetName)];
    const rm = oid ? teamById.get(oid) : teamByName.get(norm(sheet.rmSheetName));
    if (!rm) continue;
    for (const e of sheet.entries) {
      const cands = clientsByName.get(norm(e.investor)) || [];
      const client = cands.find(c => c.primaryOwnerId === rm.id) || cands[0];
      if (!client || seen.has(client.id)) continue;
      const cur = client.primaryOwnerId;
      if (cur && cur !== rm.id) {
        seen.add(client.id);
        const curT = teamById.get(cur);
        const samePerson = curT && norm(curT.name) === norm(rm.name);
        conflicts.push({
          client: client.name,
          curName: curT ? curT.name : 'UNKNOWN', curLevel: curT ? curT.level : '?', curId: cur,
          rmName: rm.name, rmLevel: rm.level, rmId: rm.id,
          category: samePerson ? 'B (same person, diff level)' : 'C (different person)',
        });
      }
    }
  }
  console.log(`\n===== REPORT 1: ${conflicts.length} remaining RM conflicts =====`);
  for (const c of conflicts) {
    console.log(`• ${c.client}  [${c.category}]`);
    console.log(`    now:   ${c.curName} (L${c.curLevel})  ${c.curId}`);
    console.log(`    excel: ${c.rmName} (L${c.rmLevel})  ${c.rmId}`);
  }

  // ── Report 2: duplicate team records + usage ────────────────────────────────
  const byName = new Map();
  for (const t of teamRows) { const k = norm(t.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(t); }

  // Usage counts per team id.
  const usePrimary = new Map(), useHierarchy = new Map(), useParent = new Map();
  const inc = (m, id) => id && m.set(id, (m.get(id) || 0) + 1);
  for (const c of clientRows) {
    inc(usePrimary, c.primaryOwnerId);
    const h = parse(c.data).hierarchy || {};
    for (let lvl = 1; lvl <= 7; lvl++) inc(useHierarchy, h[`level${lvl}Id`]);
  }
  for (const t of teamRows) inc(useParent, t.parentId);

  let payoutByUser = new Map();
  try {
    const [pl] = await pool.query('SELECT userId, COUNT(*) c FROM payout_ledger GROUP BY userId');
    for (const r of pl) payoutByUser.set(r.userId, r.c);
  } catch { /* table may be absent */ }

  const dupes = [...byName.entries()].filter(([, arr]) => arr.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`\n===== REPORT 2: ${dupes.length} duplicate team names =====`);
  console.log('(primaryOwner = clients owned, hierRefs = appearances across all hierarchy levels, payouts = payout_ledger rows, childTeam = team members parented to it)\n');
  for (const [, arr] of dupes) {
    console.log(`${arr[0].name}`);
    for (const t of arr) {
      console.log(`    L${t.level}  ${t.id}  | primaryOwner=${usePrimary.get(t.id) || 0}  hierRefs=${useHierarchy.get(t.id) || 0}  payouts=${payoutByUser.get(t.id) || 0}  childTeam=${useParent.get(t.id) || 0}`);
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
