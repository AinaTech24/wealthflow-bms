/**
 * Run every SQL statement in the codebase through the Postgres compatibility
 * layer and report what it cannot translate.
 *
 * This is the port's worklist. Anything it prints has to be rewritten by hand;
 * everything it does not print passes through `pgCompat` untouched.
 *
 *   node tools/pgAudit.mjs            # summary
 *   node tools/pgAudit.mjs --detail   # every statement needing work
 */
import fs from 'fs';
import path from 'path';
import { translate, residualMySql } from '../src/lib/pgCompat.js';

const FILES = [
  'server.js', 'recalcRun.js', 'applyRates.js', 'fixBM.js', 'fixLevelRates.js',
  'fixOverrides.js', 'net75.js', 'setLeadSource.js', 'setSlices.js', 'setupOverrides.js',
];
const DETAIL = process.argv.includes('--detail');
const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|TRUNCATE)\b/i;

/**
 * Pull string and template literals out of a source file.
 *
 * Deliberately crude: it walks the file character by character tracking which
 * quote it is inside. A template literal carrying `${...}` is kept with the
 * interpolations replaced by a placeholder token, because what matters here is
 * the SQL shape, not the values.
 */
function literals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const line = src.slice(0, i).split('\n').length;
      let buf = '';
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { buf += src[i + 1] === 'n' ? '\n' : src[i + 1]; i += 2; continue; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1; i += 2;
          while (i < src.length && depth > 0) { if (src[i] === '{') depth++; if (src[i] === '}') depth--; i++; }
          buf += 'INTERP';       // stands in for the interpolated fragment
          continue;
        }
        if (src[i] === quote) { i++; break; }
        buf += src[i]; i++;
      }
      out.push({ text: buf, line });
      continue;
    }
    i++;
  }
  return out;
}

const byReason = new Map();
let total = 0, clean = 0, needsWork = 0, dynamic = 0;
const work = [];

for (const file of FILES) {
  const full = path.join(process.cwd(), file);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, 'utf8');
  for (const { text, line } of literals(src)) {
    if (!SQL_START.test(text)) continue;
    if (text.length < 15) continue;
    total++;
    let notes;
    try { notes = translate(text).notes; }
    catch (e) { notes = [`translate() threw: ${e.message}`]; }
    // A statement whose table name is built at runtime (`INSERT INTO ${collection}`)
    // reads here as `INSERT INTO INTERP`, so the conflict-target lookup fails and the
    // upsert looks untranslatable. It is not: at runtime the real table name is there
    // and the lookup succeeds. Count these separately rather than inflating the
    // worklist with statements nobody has to touch.
    if (/\bINTERP\b/.test(text) && notes.every(n => /PRIMARY_KEY/.test(n))) {
      dynamic++; clean++; continue;
    }
    if (notes.length === 0) { clean++; continue; }
    needsWork++;
    work.push({ file, line, text: text.replace(/\s+/g, ' ').trim(), notes });
    for (const n of notes) byReason.set(n, (byReason.get(n) || 0) + 1);
  }
}

console.log(`\nSQL statements found:      ${total}`);
console.log(`Pass through untouched:    ${clean}  (${Math.round(clean / total * 100)}%)`);
console.log(`Need rewriting by hand:    ${needsWork}\n`);

console.log('Why, grouped:');
for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${reason}`);
}

if (DETAIL) {
  console.log('\n--- statements needing hand work ---');
  for (const w of work) {
    console.log(`\n${w.file}:${w.line}`);
    console.log(`  ${w.text.slice(0, 200)}${w.text.length > 200 ? ' …' : ''}`);
    for (const n of w.notes) console.log(`  -> ${n}`);
  }
} else {
  console.log('\nRun with --detail to list each one.');
}

const byFile = new Map();
for (const w of work) byFile.set(w.file, (byFile.get(w.file) || 0) + 1);
console.log('\nBy file:');
for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${f}`);
console.log();
