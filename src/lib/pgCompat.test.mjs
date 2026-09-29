/**
 * Tests for the MySQL → Postgres compatibility layer.
 *
 * Every SQL string below is copied from `server.js` as it stands, not invented.
 * If one of these stops translating correctly the port is broken in production,
 * not in theory.
 *
 *   node src/lib/pgCompat.test.mjs
 */
import { translate, reviveRow, reviveRows, residualMySql, PRIMARY_KEY } from './pgCompat.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const eq = (got, want, what = '') => {
  const g = typeof got === 'string' ? got : JSON.stringify(got);
  const w = typeof want === 'string' ? want : JSON.stringify(want);
  if (g !== w) throw new Error(`${what}\n       got:  ${g}\n       want: ${w}`);
};
const has = (got, needle) => {
  if (!String(got).includes(needle)) throw new Error(`missing ${JSON.stringify(needle)}\n       in: ${got}`);
};

console.log('\npgCompat — placeholders');

t('numbers ? in order', () => {
  const { text, values } = translate(
    'SELECT id, grossAmount FROM transactions WHERE id>? ORDER BY id LIMIT ?', ['x', 500]);
  eq(text, 'SELECT id, grossAmount FROM transactions WHERE id>$1 ORDER BY id LIMIT $2');
  eq(values, ['x', 500]);
});

t('leaves a ? inside a string literal alone', () => {
  const { text, values } = translate(
    "SELECT * FROM t WHERE note LIKE '%?%' AND id = ?", ['a']);
  eq(text, "SELECT * FROM t WHERE note LIKE '%?%' AND id = $1");
  eq(values, ['a']);
});

t('leaves a ? inside a line comment alone', () => {
  const { text } = translate('SELECT 1 -- what? really\nWHERE id = ?', ['a']);
  has(text, '-- what? really');
  has(text, 'id = $1');
});

console.log('\npgCompat — IN (?) with an array');

t('IN (?) becomes = ANY($n)', () => {
  const ids = ['t1', 't2', 't3'];
  const { text, values } = translate(
    'DELETE FROM payout_ledger WHERE transactionId IN (?)', [ids]);
  eq(text, 'DELETE FROM payout_ledger WHERE transactionId = ANY($1)');
  eq(values, [ids]);
});

t('NOT IN (?) becomes <> ALL($n)', () => {
  const { text } = translate('SELECT * FROM t WHERE id NOT IN (?)', [['a', 'b']]);
  has(text, '<> ALL($1)');
});

t('an expanded IN (?,?,?) list is left as positional params', () => {
  const { text, values } = translate(
    'SELECT * FROM transactions WHERE mappedClientId IN (?,?,?)', ['a', 'b', 'c']);
  eq(text, 'SELECT * FROM transactions WHERE mappedClientId IN ($1,$2,$3)');
  eq(values, ['a', 'b', 'c']);
});

console.log('\npgCompat — VALUES ? bulk insert');

t('VALUES ? expands a 2-D array', () => {
  const rows = [['id1', '{}'], ['id2', '{}']];
  const { text, values } = translate('INSERT INTO transactions (id,data) VALUES ?', [rows]);
  eq(text, 'INSERT INTO transactions (id,data) VALUES ($1, $2), ($3, $4)');
  eq(values, ['id1', '{}', 'id2', '{}']);
});

console.log('\npgCompat — ON DUPLICATE KEY UPDATE');

t('single-column upsert on transactions', () => {
  const rows = [['id1', '{}']];
  const { text } = translate(
    'INSERT INTO transactions (id,data) VALUES ? ON DUPLICATE KEY UPDATE data=VALUES(data)', [rows]);
  has(text, 'ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data');
});

t('multi-column upsert on batches', () => {
  const { text } = translate(
    'INSERT INTO batches (id, fileName, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE fileName=VALUES(fileName), data=VALUES(data)',
    ['b1', 'f.xls', '{}']);
  has(text, 'ON CONFLICT (id) DO UPDATE SET fileName=EXCLUDED.fileName, data=EXCLUDED.data');
});

t('payout_ledger upserts on its composite unique key, not a primary key', () => {
  const { text } = translate(
    'INSERT INTO payout_ledger (transactionId, userId, amount, level) VALUES ? ON DUPLICATE KEY UPDATE amount=VALUES(amount), level=VALUES(level)',
    [[['t1', 'u1', 5, 3]]]);
  has(text, 'ON CONFLICT (transactionid, userid) DO UPDATE SET');
});

t('an unknown table is left alone rather than guessed at', () => {
  const { text, notes } = translate(
    'INSERT INTO not_a_real_table (id) VALUES (?) ON DUPLICATE KEY UPDATE id=VALUES(id)', ['x']);
  has(text, 'ON DUPLICATE KEY UPDATE');
  if (!notes.length) throw new Error('should have flagged the untranslated upsert');
});

console.log('\npgCompat — JSON accessors');

t('JSON_UNQUOTE(JSON_EXTRACT(...)) becomes ->>', () => {
  const { text } = translate(
    "SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.folio')) folio FROM transactions");
  eq(text, "SELECT data->>'folio' folio FROM transactions");
});

t('the flagged-row predicate that once matched everything', () => {
  // The MariaDB form, as it stands in server.js today.
  const { text } = translate(
    "SELECT * FROM transactions WHERE NOT (JSON_UNQUOTE(JSON_EXTRACT(data,'$.aumUnreliable')) <=> 'true')");
  has(text, "data->>'aumUnreliable'");
  has(text, 'IS NOT DISTINCT FROM');
});

t('a nested JSON path is NOT guessed at', () => {
  const sql = "SELECT JSON_EXTRACT(data,'$.a.b') FROM t";
  const { text, notes } = translate(sql);
  eq(text, sql, 'nested path must pass through untouched');
  if (!notes.length) throw new Error('should have flagged the nested JSON path');
});

console.log('\npgCompat — dates and operators');

t('DATE_FORMAT + DATE_SUB + CURDATE together', () => {
  const { text } = translate(
    "SELECT * FROM transactions WHERE brokeragePeriod >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 18 MONTH), '%Y-%m')");
  has(text, "to_char((CURRENT_DATE - INTERVAL '18 month'), 'YYYY-MM')");
});

t('IFNULL and CHAR_LENGTH', () => {
  const { text } = translate('SELECT IFNULL(a,0), CHAR_LENGTH(b) FROM t');
  eq(text, 'SELECT COALESCE(a,0), LENGTH(b) FROM t');
});

console.log('\npgCompat — column case revival');

t('maps the columns the code reads by camelCase', () => {
  const row = { id: 'x', mappedclientid: 'c1', grossamount: '5.00', brokerageperiod: '2026-08' };
  eq(reviveRow(row), { id: 'x', mappedClientId: 'c1', grossAmount: '5.00', brokeragePeriod: '2026-08' });
});

t('leaves query aliases alone', () => {
  const row = { cid: 'c1', v: 12.5, p: '2026-08' };
  eq(reviveRow(row), { cid: 'c1', v: 12.5, p: '2026-08' });
});

t('returns the same object when nothing needs renaming', () => {
  const row = { id: 'x', name: 'y' };
  if (reviveRow(row) !== row) throw new Error('should not copy when nothing changed');
});

t('reviveRows maps a whole result set', () => {
  eq(reviveRows([{ userid: 'u1' }, { userid: 'u2' }]), [{ userId: 'u1' }, { userId: 'u2' }]);
});

console.log('\npgCompat — residual detection');

t('flags MySQL DDL', () => {
  const found = residualMySql('CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, d LONGTEXT)');
  if (!found.length) throw new Error('should have flagged AUTO_INCREMENT / LONGTEXT');
});

t('flags SHOW', () => {
  if (!residualMySql("SHOW VARIABLES LIKE 'sql_mode'").length) throw new Error('should have flagged SHOW');
});

t('clean SQL produces no notes', () => {
  const { notes } = translate('SELECT COUNT(*) FROM transactions WHERE brokeragePeriod = ?', ['2026-08']);
  eq(notes, []);
});

console.log('\npgCompat — schema map');

t('every table in PRIMARY_KEY has at least one column', () => {
  for (const [table, cols] of Object.entries(PRIMARY_KEY)) {
    if (!Array.isArray(cols) || cols.length === 0) throw new Error(`${table} has no conflict target`);
    for (const c of cols) if (c !== c.toLowerCase()) throw new Error(`${table}.${c} must be lowercase`);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
