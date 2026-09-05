// READ-ONLY. Lists clients whose current primaryOwnerId differs from the RM the
// source workbook assigns (the "kept old" cases from importInvestorMapping.js).
// Shows current-owner name/level vs Excel-RM name/level so a human can decide
// whether to overwrite. Writes nothing.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.resolve(__dirname, '../../investor_mapping.json');
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const SHEET_RM_OVERRIDES = { 'sarvottam wealthnetwork private': 'tm_1769496581772' };

async function main() {
  const mapping = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
  const [teamRows] = await pool.query('SELECT id, name, level FROM team');
  const teamByName = new Map(), teamById = new Map();
  for (const t of teamRows) {
    teamById.set(t.id, t);
    const k = norm(t.name); const prev = teamByName.get(k);
    if (!prev || (t.level === 1 && prev.level !== 1)) teamByName.set(k, t);
  }
  const [clientRows] = await pool.query('SELECT id, primaryOwnerId, name FROM clients');
  const clientsByName = new Map();
  for (const c of clientRows) {
    const k = norm(c.name);
    if (!clientsByName.has(k)) clientsByName.set(k, []);
    clientsByName.get(k).push(c);
  }

  const conflicts = [];
  const seen = new Set();
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
        conflicts.push({
          client: client.name,
          currentOwner: curT ? `${curT.name} (L${curT.level})` : `UNKNOWN(${cur})`,
          excelRM: `${rm.name} (L${rm.level})`,
          sheet: sheet.rmSheetName,
        });
      }
    }
  }

  console.log(`RM-ownership conflicts (current owner ≠ Excel RM): ${conflicts.length}\n`);
  for (const c of conflicts) {
    console.log(`• ${c.client}\n    now:   ${c.currentOwner}\n    excel: ${c.excelRM}  [sheet: ${c.sheet}]`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
