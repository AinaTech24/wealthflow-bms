// Map clients & folios to RMs from a per-RM Investor-wise brokerage workbook.
//
// Sheet name = RM name (matches team.name where level=1).
// Each row: AMC Name | Investor | Folio | Scheme | RM Name | Trxn Date | RM Brokerage
//
// What this does per (RM-sheet, row):
//   1. Find the RM in `team` by name (case-insensitive, level=1 preferred).
//   2. Find the client in `clients` by name (case-insensitive); create a new
//      one if no match (id = "client_<ts>_<rand>", PAN blank).
//   3. Add Folio to client.data.folios (dedup).
//   4. Set client.primaryOwnerId = rm.id AND client.data.hierarchy.level1Id = rm.id.
//      Existing higher levels are preserved.
//
// Usage:
//   node src/scripts/importInvestorMapping.js                # dry run, prints summary
//   node src/scripts/importInvestorMapping.js --apply        # writes to DB
//   node src/scripts/importInvestorMapping.js --apply --force-overwrite-rm
//        # also reassigns clients already mapped to a different RM
//
// Input file: ./investor_mapping.json (produced from the source xlsx).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pool from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = process.argv.slice(2);
const args = new Set(argv);
const APPLY = args.has('--apply');
const FORCE_OVERWRITE_RM = args.has('--force-overwrite-rm');
// --overwrite-from=id1,id2 : overwrite an existing RM ONLY when the current
// owner is one of these team ids (e.g. the admin_root placeholder). Narrower
// than --force-overwrite-rm, which overwrites regardless of current owner.
const OVERWRITE_FROM = new Set(
  (argv.find(a => a.startsWith('--overwrite-from=')) || '').split('=')[1]?.split(',').filter(Boolean) || []
);
const INPUT = path.resolve(__dirname, '../../investor_mapping.json');

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Explicit sheet-name → team.id overrides. Used when a sheet name is truncated
// (Excel caps sheet names at 31 chars) or when multiple team rows share a name
// and the correct one must be pinned. Keyed by norm(sheetName).
const SHEET_RM_OVERRIDES = {
  // "Sarvottam Wealthnetwork Private" (truncated) → level-6 record, per user choice.
  'sarvottam wealthnetwork private': 'tm_1769496581772',
};

function newClientId() {
  return `client_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function parseClientData(raw) {
  if (!raw) return {};
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return {}; }
}

function emptyHierarchy() {
  return { level1Id: '', level2Id: '', level3Id: '', level4Id: '', level5Id: '', level6Id: '', level7Id: '' };
}

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`[ERR] Mapping file not found: ${INPUT}`);
    console.error('Generate it first by parsing the source xlsx.');
    process.exit(1);
  }
  const mapping = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));

  console.log(`Mode: ${APPLY ? 'APPLY (writes DB)' : 'DRY-RUN (no writes)'}`);
  console.log(`Force-overwrite existing RM mapping: ${FORCE_OVERWRITE_RM}`);
  if (OVERWRITE_FROM.size) console.log(`Overwrite only when current owner in: ${[...OVERWRITE_FROM].join(', ')}`);
  console.log(`Source: ${INPUT}`);
  console.log(`Sheets in source: ${mapping.rms.length}`);

  // ── Load team ─────────────────────────────────────────────────────────────
  const [teamRows] = await pool.query('SELECT id, name, code, role, level FROM team');
  const teamByName = new Map();          // norm(name) -> team row (prefer level=1)
  const teamById = new Map();            // id -> team row
  for (const t of teamRows) {
    teamById.set(t.id, t);
    const k = norm(t.name);
    const prev = teamByName.get(k);
    if (!prev || (t.level === 1 && prev.level !== 1)) teamByName.set(k, t);
  }
  console.log(`Loaded ${teamRows.length} team members (level-1 RMs: ${teamRows.filter(t => t.level === 1).length}).`);

  // ── Load clients ──────────────────────────────────────────────────────────
  const [clientRows] = await pool.query('SELECT id, primaryOwnerId, pan, name, data FROM clients');
  const clientsByName = new Map();       // norm(name) -> [client row]
  for (const c of clientRows) {
    const k = norm(c.name);
    if (!clientsByName.has(k)) clientsByName.set(k, []);
    clientsByName.get(k).push(c);
  }
  console.log(`Loaded ${clientRows.length} existing clients.`);

  // ── Plan ──────────────────────────────────────────────────────────────────
  const stats = {
    rmsMatched: 0,
    rmsMissing: [],
    clientsCreated: 0,
    clientsUpdated: 0,
    foliosAdded: 0,
    rmReassignments: 0,
    rmReassignSkipped: 0,
    rowsProcessed: 0,
    rowsSkippedNoRm: 0,
  };
  const writes = new Map();              // clientId -> staged row {id, primaryOwnerId, pan, name, data, _new}

  function stageWrite(client) {
    writes.set(client.id, client);
  }

  for (const sheet of mapping.rms) {
    const overrideId = SHEET_RM_OVERRIDES[norm(sheet.rmSheetName)];
    const rm = overrideId ? teamById.get(overrideId) : teamByName.get(norm(sheet.rmSheetName));
    if (!rm) {
      stats.rmsMissing.push(sheet.rmSheetName);
      stats.rowsSkippedNoRm += sheet.entries.length;
      continue;
    }
    stats.rmsMatched++;

    for (const e of sheet.entries) {
      stats.rowsProcessed++;
      const investorKey = norm(e.investor);
      let candidates = clientsByName.get(investorKey) || [];

      // Prefer an existing match already owned by this RM
      let client = candidates.find(c => c.primaryOwnerId === rm.id) || candidates[0];
      let isNew = false;

      if (!client) {
        const id = newClientId();
        client = {
          id, primaryOwnerId: rm.id, pan: '', name: e.investor.trim(),
          data: JSON.stringify({ folios: [], hierarchy: { ...emptyHierarchy(), level1Id: rm.id } }),
          _new: true,
        };
        stats.clientsCreated++;
        isNew = true;
        clientsByName.set(investorKey, [...(candidates), client]);
      }

      // Pull a working copy from writes if we already staged it this run
      const staged = writes.get(client.id) || { ...client };
      const data = parseClientData(staged.data);
      data.folios = Array.isArray(data.folios) ? data.folios : [];
      data.hierarchy = { ...emptyHierarchy(), ...(data.hierarchy || {}) };

      // Folio merge (case-sensitive, exact string)
      const folio = String(e.folio || '').trim();
      if (folio && !data.folios.includes(folio)) {
        data.folios.push(folio);
        stats.foliosAdded++;
      }

      // RM assignment
      const existingOwner = staged.primaryOwnerId;
      const allowOverwrite = !existingOwner || existingOwner === rm.id
        || FORCE_OVERWRITE_RM || OVERWRITE_FROM.has(existingOwner);
      if (allowOverwrite) {
        if (existingOwner && existingOwner !== rm.id) stats.rmReassignments++;
        staged.primaryOwnerId = rm.id;
        data.hierarchy.level1Id = rm.id;
      } else {
        stats.rmReassignSkipped++;
      }

      staged.data = JSON.stringify(data);
      if (!isNew) stats.clientsUpdated++;          // counted per row; collapsed below
      stageWrite(staged);
    }
  }

  // collapse clientsUpdated to per-client count (excluding new)
  const updatedCount = [...writes.values()].filter(w => !w._new).length;
  stats.clientsUpdated = updatedCount;
  const newCount = [...writes.values()].filter(w => w._new).length;
  stats.clientsCreated = newCount;

  console.log('\n── Plan summary ───────────────────────────────────────');
  console.log(`RM sheets matched to team:        ${stats.rmsMatched}/${mapping.rms.length}`);
  console.log(`RM sheets with NO team match:     ${stats.rmsMissing.length}`);
  if (stats.rmsMissing.length) {
    console.log('  Missing RM names (add to team or rename sheet):');
    for (const n of stats.rmsMissing) console.log(`    - ${n}`);
  }
  console.log(`Rows processed:                   ${stats.rowsProcessed}`);
  console.log(`Rows skipped (no RM):             ${stats.rowsSkippedNoRm}`);
  console.log(`Clients to create (new):          ${stats.clientsCreated}`);
  console.log(`Clients to update (existing):     ${stats.clientsUpdated}`);
  console.log(`Folios to add:                    ${stats.foliosAdded}`);
  console.log(`RM reassignments (overwriting):   ${stats.rmReassignments}`);
  console.log(`RM reassign skipped (kept old):   ${stats.rmReassignSkipped}`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to write to DB.');
    process.exit(0);
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const rows = [...writes.values()].map(w => [w.id, w.primaryOwnerId, w.pan || '', w.name || '', w.data]);
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await pool.query(
      `INSERT INTO clients (id, primaryOwnerId, pan, name, data) VALUES ?
       ON DUPLICATE KEY UPDATE primaryOwnerId=VALUES(primaryOwnerId), name=VALUES(name), data=VALUES(data)`,
      [chunk]
    );
    written += chunk.length;
    console.log(`  ...wrote ${written}/${rows.length}`);
  }
  console.log(`\n✅ Done. ${written} client rows upserted.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
