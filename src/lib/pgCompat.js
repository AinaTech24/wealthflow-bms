/**
 * MySQL/MariaDB → PostgreSQL compatibility layer.
 *
 * The point of this file is that `server.js` keeps its 184 query call sites, its
 * ~558 `?` placeholders and its camelCase property reads EXACTLY as written. Only
 * the genuinely MySQL-specific statements get rewritten by hand; everything else
 * passes through here.
 *
 * It does three jobs:
 *
 *   1. Placeholders.  `?` → `$1 … $n`, string- and comment-aware so a `?` inside
 *      a quoted literal is left alone. `IN (?)` with an array parameter becomes
 *      `= ANY($n)`, and `VALUES ?` with a 2-D array expands to `($1,$2),($3,$4)`.
 *
 *   2. Dialect.  `ON DUPLICATE KEY UPDATE x=VALUES(x)` → `ON CONFLICT (pk) DO
 *      UPDATE SET x=EXCLUDED.x`, plus the JSON accessors, `<=>`, and the date
 *      functions. The conflict target comes from PRIMARY_KEY below, which is why
 *      that map has to stay in step with the schema.
 *
 *   3. Column names.  Postgres folds unquoted identifiers to lowercase, so a row
 *      comes back with `mappedclientid` where the code reads `r.mappedClientId`
 *      — undefined, silently, in ~750 places. `reviveRow` maps the known column
 *      names back. This is the single reason the schema is created WITHOUT quoted
 *      identifiers: the SQL then needs no edits at all, and the whole problem
 *      lives in COLUMN_CASE below.
 *
 * What this file deliberately does NOT do: guess. Anything it cannot translate
 * with certainty is left as-is so Postgres raises a loud syntax error, rather
 * than being silently rewritten into something that runs but means something
 * else. That failure mode — a predicate that still executes but matches the
 * wrong rows — is exactly what cost this project a week when
 * `COALESCE(JSON_EXTRACT(...), FALSE) <> TRUE` matched every flagged row.
 */

/** Conflict target per table, for ON DUPLICATE KEY UPDATE. Keep in step with the DDL. */
export const PRIMARY_KEY = {
  team: ['id'],
  clients: ['id'],
  transactions: ['id'],
  transactions_trash: ['id'],
  batches: ['id'],
  amc_mappings: ['original'],
  scheme_mappings: ['original'],
  config: ['id'],
  invoices: ['id'],
  activity_log: ['id'],
  brokerage_masters: ['id'],
  partner_brokerage: ['id'],
  partner_client_map: ['partner', 'clientcode'],
  payout_settlements: ['id'],
  schema_migrations: ['name'],
  // No PRIMARY KEY — the upsert rides the UNIQUE KEY unq_tx_user.
  payout_ledger: ['transactionid', 'userid'],
};

/** lowercase (what Postgres returns) → camelCase (what the code reads). */
export const COLUMN_CASE = {
  amcname: 'amcName',
  appliedat: 'appliedAt',
  batchid: 'batchId',
  brokerageperiod: 'brokeragePeriod',
  clientcode: 'clientCode',
  clientid: 'clientId',
  createdat: 'createdAt',
  createdby: 'createdBy',
  filename: 'fileName',
  grossamount: 'grossAmount',
  investorname: 'investorName',
  mappedclientid: 'mappedClientId',
  ourshare: 'ourShare',
  paidon: 'paidOn',
  parentid: 'parentId',
  partnershare: 'partnerShare',
  primaryownerid: 'primaryOwnerId',
  schemename: 'schemeName',
  totalbrokerage: 'totalBrokerage',
  tradecategory: 'tradeCategory',
  tradedate: 'tradeDate',
  trailrate: 'trailRate',
  transactiondate: 'transactionDate',
  transactionid: 'transactionId',
  trashedat: 'trashedAt',
  updatedat: 'updatedAt',
  userid: 'userId',
  username: 'userName',
};

/**
 * Split SQL into code and literal segments.
 *
 * Every rewrite below runs over code segments only. Without this, a `?` inside
 * `LIKE '%?%'`, or the `$.folio` inside a JSON path literal, would be mangled.
 */
function segments(sql) {
  const out = [];
  let i = 0, start = 0;
  const push = (end, literal) => { if (end > start) out.push({ text: sql.slice(start, end), literal }); };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      push(i, false); start = i;
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\') { i += 2; continue; }          // MySQL-style escape
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue; }  // '' escape
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      push(i, true); start = i;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      push(i, false); start = i;
      while (i < sql.length && sql[i] !== '\n') i++;
      push(i, true); start = i;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      push(i, false); start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(i + 2, sql.length);
      push(i, true); start = i;
      continue;
    }
    i++;
  }
  push(sql.length, false);
  return out;
}

/** Apply `fn` to the code segments of `sql`, leaving string literals untouched. */
function onCode(sql, fn) {
  return segments(sql).map(s => (s.literal ? s.text : fn(s.text))).join('');
}

/**
 * MySQL function and operator forms that have an exact Postgres equivalent.
 *
 * Only exact equivalents belong here. `JSON_EXTRACT` with a nested path, for
 * instance, is left alone on purpose: `data->>'a.b'` is NOT the same as
 * `data#>>'{a,b}'`, and a wrong guess is worse than a syntax error.
 */
function rewriteDialect(sql) {
  let out = sql;

  // Backtick-quoted identifiers → bare (they fold to lowercase, which is what we want).
  out = onCode(out, s => s.replace(/`([A-Za-z_][A-Za-z0-9_]*)`/g, '$1'));

  // JSON_UNQUOTE(JSON_EXTRACT(col,'$.key')) → col->>'key'   (top-level keys only)
  out = out.replace(
    /JSON_UNQUOTE\s*\(\s*JSON_EXTRACT\s*\(\s*([A-Za-z_][\w.]*)\s*,\s*'\$\.([A-Za-z_][\w]*)'\s*\)\s*\)/gi,
    "$1->>'$2'");

  // Bare JSON_EXTRACT(col,'$.key') in a text context → col->>'key'
  out = out.replace(
    /JSON_EXTRACT\s*\(\s*([A-Za-z_][\w.]*)\s*,\s*'\$\.([A-Za-z_][\w]*)'\s*\)/gi,
    "$1->>'$2'");

  // JSON_VALID(x) → (x IS NOT NULL)  — jsonb cannot hold invalid JSON by construction.
  out = out.replace(/JSON_VALID\s*\(\s*([A-Za-z_][\w.]*)\s*\)\s*=\s*0/gi, 'FALSE /* JSON_VALID: jsonb is always valid */');

  out = onCode(out, s => s
    // Null-safe equality.
    .replace(/<=>/g, ' IS NOT DISTINCT FROM ')
    // Date and time.
    .replace(/\bCURDATE\s*\(\s*\)/gi, 'CURRENT_DATE')
    .replace(/\bCURRENT_TIMESTAMP\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\bUTC_TIMESTAMP\s*\(\s*\)/gi, "(NOW() AT TIME ZONE 'UTC')")
    .replace(/\bIFNULL\s*\(/gi, 'COALESCE(')
    .replace(/\bCHAR_LENGTH\s*\(/gi, 'LENGTH(')
    // Integer division and modulo keyword forms.
    .replace(/\bDIV\b/g, '/')
  );

  // DATE_SUB(x, INTERVAL n UNIT) / DATE_ADD(...) — BEFORE DATE_FORMAT, because the
  // two nest (`DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 18 MONTH), '%Y-%m')`) and the
  // inner call's own comma would otherwise stop the outer pattern matching at all.
  out = out.replace(/DATE_(SUB|ADD)\s*\(\s*([^,]+?)\s*,\s*INTERVAL\s+(\d+)\s+([A-Z]+)\s*\)/gi,
    (_, dir, expr, n, unit) => `(${expr} ${dir.toUpperCase() === 'SUB' ? '-' : '+'} INTERVAL '${n} ${unit.toLowerCase()}')`);

  // DATE_FORMAT(x, '%Y-%m') → to_char(x, 'YYYY-MM'). The expression may carry one
  // level of parentheses, which is what the rewrite above leaves behind.
  out = out.replace(/DATE_FORMAT\s*\(\s*((?:[^,()]|\([^()]*\))+?)\s*,\s*'([^']+)'\s*\)/gi, (_, expr, fmt) => {
    const pg = fmt.replace(/%Y/g, 'YYYY').replace(/%m/g, 'MM').replace(/%d/g, 'DD')
                  .replace(/%H/g, 'HH24').replace(/%i/g, 'MI').replace(/%s/gi, 'SS');
    return `to_char(${expr}, '${pg}')`;
  });

  // INSERT IGNORE INTO t → INSERT INTO t … ON CONFLICT DO NOTHING
  let ignored = null;
  out = out.replace(/INSERT\s+IGNORE\s+INTO\s+([A-Za-z_][\w]*)/i, (_, table) => {
    ignored = table;
    return `INSERT INTO ${table}`;
  });
  if (ignored && !/ON\s+CONFLICT/i.test(out)) out = `${out.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;

  // ON DUPLICATE KEY UPDATE a=VALUES(a), b=VALUES(b)
  //   → ON CONFLICT (pk) DO UPDATE SET a=EXCLUDED.a, b=EXCLUDED.b
  out = out.replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE\s+([\s\S]+?)(?=$|;)/i, (whole, assignments) => {
    const table = (out.match(/INSERT\s+INTO\s+([A-Za-z_][\w]*)/i) || [])[1];
    const pk = table && PRIMARY_KEY[table.toLowerCase()];
    if (!pk) return whole;    // unknown table: leave it, Postgres will say so loudly
    const set = assignments
      .replace(/VALUES\s*\(\s*([A-Za-z_][\w]*)\s*\)/gi, 'EXCLUDED.$1')
      .trim();
    return `ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${set}`;
  });

  return out;
}

/** Everything left in the SQL that this layer knows it cannot translate. */
export function residualMySql(sql) {
  const found = [];
  const checks = [
    [/JSON_EXTRACT/i, 'JSON_EXTRACT with a path this layer does not translate'],
    [/JSON_UNQUOTE/i, 'JSON_UNQUOTE left untranslated'],
    [/JSON_CONTAINS|JSON_SET|JSON_ARRAY/i, 'MySQL JSON function with no automatic equivalent'],
    [/ON\s+DUPLICATE\s+KEY/i, 'ON DUPLICATE KEY UPDATE on a table missing from PRIMARY_KEY'],
    [/\bSTRAIGHT_JOIN\b|\bGROUP_CONCAT\b|\bREPLACE\s+INTO\b/i, 'MySQL-only syntax'],
    [/\bSHOW\s+(VARIABLES|TABLES|COLUMNS|INDEX)/i, 'SHOW is MySQL-only; use the pg_catalog views'],
    [/\bAUTO_INCREMENT\b|\bLONGTEXT\b|\bDATETIME\b|\bENGINE\s*=/i, 'MySQL DDL'],
  ];
  for (const [re, why] of checks) if (re.test(sql)) found.push(why);
  return found;
}

/**
 * Translate one mysql2 call into a node-postgres one.
 *
 * @param {string} sql     the statement as `server.js` writes it
 * @param {Array}  params  the mysql2 parameter list
 * @returns {{text: string, values: Array, notes: string[]}}
 */
export function translate(sql, params = []) {
  const rewritten = rewriteDialect(sql);
  const values = [];
  let out = '';
  let pi = 0;          // index into params
  let skipCloseParen = false;

  for (const seg of segments(rewritten)) {
    if (seg.literal) { out += seg.text; continue; }
    let buf = '';
    for (let i = 0; i < seg.text.length; i++) {
      const ch = seg.text[i];

      if (skipCloseParen && ch === ')') { skipCloseParen = false; continue; }

      if (ch !== '?') { buf += ch; continue; }

      const param = params[pi++];
      const before = (out + buf);

      // `VALUES ?` with a 2-D array → ($1,$2),($3,$4)
      if (Array.isArray(param) && Array.isArray(param[0]) && /\bVALUES\s*$/i.test(before)) {
        const tuples = param.map(row => {
          const slots = row.map(v => { values.push(v); return `$${values.length}`; });
          return `(${slots.join(', ')})`;
        });
        buf += tuples.join(', ');
        continue;
      }

      // `IN (?)` / `NOT IN (?)` with a flat array → `= ANY($n)` / `<> ALL($n)`
      const inMatch = before.match(/(\s+(NOT\s+)?IN\s*\(\s*)$/i);
      if (Array.isArray(param) && inMatch && /^\s*\)/.test(seg.text.slice(i + 1))) {
        const negated = Boolean(inMatch[2]);
        const cut = inMatch[1].length;
        // Unwind the `IN (` we already emitted, from buf or from out.
        if (buf.length >= cut) buf = buf.slice(0, buf.length - cut);
        else { out = out.slice(0, out.length - (cut - buf.length)); buf = ''; }
        values.push(param);
        buf += negated ? ` <> ALL($${values.length})` : ` = ANY($${values.length})`;
        skipCloseParen = true;
        continue;
      }

      values.push(param);
      buf += `$${values.length}`;
    }
    out += buf;
  }

  return { text: out, values, notes: residualMySql(out) };
}

/**
 * Put the camelCase back on a result row.
 *
 * Only the known columns are renamed. An unrecognised lowercase key is left as
 * it is: a query alias the code already reads in lowercase must keep working,
 * and inventing a camelCase spelling for it would break that.
 */
export function reviveRow(row) {
  if (!row || typeof row !== 'object') return row;
  let touched = false;
  const out = {};
  for (const k of Object.keys(row)) {
    const camel = COLUMN_CASE[k];
    if (camel && camel !== k) { out[camel] = row[k]; touched = true; }
    else out[k] = row[k];
  }
  return touched ? out : row;
}

export function reviveRows(rows) {
  return Array.isArray(rows) ? rows.map(reviveRow) : rows;
}
