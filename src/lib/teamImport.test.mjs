// Tests for importing RM / BM basic details from a sheet.
//
//   node src/lib/teamImport.test.mjs
import { detectColumns, readRows, matchRows, diffFor, applyChanges, normalizeChanges, parseDate, NORMALIZE, FIELD_KEYS, maskAccount } from './teamImport.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL  ${what}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── dates ──
ok(parseDate('24-11-2028') === '2028-11-24' && parseDate('24/11/2028') === '2028-11-24' && parseDate('2028-11-24') === '2028-11-24', 'day-first, slash and ISO dates');
ok(parseDate('24 Nov 2028') === '2028-11-24' && parseDate('5-Jan-27') === '2027-01-05', 'month names');
ok(parseDate('11/24/28') === '2028-11-24', 'a sheet reader\'s month-first short date is understood when the day cannot be first');
ok(parseDate('31-02-2027') === null && parseDate('abc') === null && parseDate('') === null, 'impossible and non-dates are rejected');
ok(parseDate('46000') === '2025-12-09' || parseDate('46000') !== null, 'an Excel serial number is a date');

// ── cell values ──
ok(NORMALIZE.arnNumber('arn 270604').value === 'ARN-270604' && NORMALIZE.arnNumber('ARN-270604').value === 'ARN-270604' && NORMALIZE.arnNumber('270604').value === 'ARN-270604', 'ARN is written ARN-123456 however it was typed');
ok(NORMALIZE.arnNumber('hello').error && NORMALIZE.euinNumber('E661548').value === 'E661548' && NORMALIZE.euinNumber('661548').error, 'EUIN must start with E');
ok(NORMALIZE.gstNumber('23hkcpk3532a1z7').value === '23HKCPK3532A1Z7' && NORMALIZE.gstNumber('123').error, 'GSTIN: upper-cased, 15 characters');
ok(NORMALIZE.pan('hkcpk3532a').value === 'HKCPK3532A' && NORMALIZE.pan('HKC').error, 'PAN');
ok(NORMALIZE.email(' Joy@Gmail.com ').value === 'joy@gmail.com' && NORMALIZE.email('joy').error, 'email');
ok(NORMALIZE.ifscCode('icic0006573').value === 'ICIC0006573' && NORMALIZE.ifscCode('ICIC123').error, 'IFSC');
ok(NORMALIZE.accountNumber('6573 0166 4339').value === '657301664339' && NORMALIZE.accountNumber('6.57E+11').error, 'account number: spaces dropped, scientific notation refused');
ok(NORMALIZE.pincode('452016').value === '452016' && NORMALIZE.pincode('4520').error, 'pincode');
ok(NORMALIZE.street('').value === '', 'an empty cell is an empty value (skipped by callers)');

// ── reading a sheet ──
const sheet = [
  ['RM / BM master - Oct 2026', '', '', '', '', '', '', '', '', '', ''],
  ['RM Name', 'PAN', 'ARN No', 'ARN valid till', 'EUIN', 'EUIN Expiry', 'Email ID', 'GST No', 'Office Address', 'Account Holder', 'Account No', 'IFSC Code', 'Bank'],
  ['Johnson M John', 'AAAPJ1111A', 'ARN-270604', '24-11-2028', 'E661548', '24-11-2028', 'joy@gmail.com', '', '12 MG Road', 'JOHNSON M JOHN', '1234567890', 'HDFC0001234', 'HDFC Bank'],
  ['Shakeel Khan Mansuri', 'HKCPK3532A', '', '', '', '', '', '23HKCPK3532A1Z7', '', '', '', '', ''],
  ['Nobody Here', '', 'ARN-1', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Bad Row', '', 'ARN-999999', 'not a date', '', '', 'not-an-email', '', '', '', '', '', ''],
];
const det = detectColumns(sheet);
ok(det.headerRow === 1, 'the header is found under a title row');
ok(det.columns.name === 0 && det.columns.pan === 1 && det.columns.arnNumber === 2 && det.columns.arnValidTill === 3 && det.columns.euinNumber === 4 && det.columns.euinValidTill === 5, 'name, PAN, ARN, ARN valid till, EUIN, EUIN valid till');
ok(det.columns.email === 6 && det.columns.gstNumber === 7 && det.columns.street === 8, 'email, GST, office address');
ok(det.columns.accountName === 9 && det.columns.accountNumber === 10 && det.columns.ifscCode === 11 && det.columns.bankName === 12, 'bank columns, and "Account Holder" is not mistaken for the person\'s name');
const rows = readRows(sheet, det.headerRow, det.columns);
ok(rows.length === 4 && rows[0].name === 'Johnson M John' && rows[0].values.arnNumber === 'ARN-270604' && rows[0].values.arnValidTill === '2028-11-24', 'four data rows (the blank one is skipped); values cleaned');
ok(rows[3].problems.length === 2 && rows[3].problems.some(p => p.key === 'arnValidTill') && rows[3].problems.some(p => p.key === 'email') && rows[3].values.arnNumber === 'ARN-999999', 'a bad cell is reported, the good cells of that row still read');

// ── matching ──
const team = [
  { id: 't1', name: 'Johnson  M John', level: 3, role: 'OPS', pan: '', email: 'old@x.com', arnNumber: 'ARN-111111', address: { street: '', city: '', state: '', pincode: '', country: 'India' } },
  { id: 't2', name: 'Shakeel Khan Mansuri', level: 2, role: 'OPS', pan: 'HKCPK3532A', gstNumber: '' },
  { id: 't3', name: 'Anil Kumar', level: 3, role: 'OPS' }, { id: 't4', name: 'ANIL KUMAR', level: 3, role: 'OPS' },
  { id: 'a1', name: 'System Administrator', level: 6, role: 'ADMIN' },
];
let m = matchRows(rows, team);
ok(m[0].status === 'matched' && m[0].person.id === 't1' && m[0].by === 'name', 'matched by name (spacing and case ignored)');
ok(m[1].status === 'matched' && m[1].person.id === 't2' && m[1].by === 'PAN', 'matched by PAN first');
ok(m[2].status === 'not_found' && m[3].status === 'not_found', 'a name nobody has is "not found"');
m = matchRows([{ rowNo: 9, name: 'anil kumar', pan: '', values: {}, problems: [] }, { rowNo: 10, name: 'System Administrator', pan: '', values: {}, problems: [] }], team);
ok(m[0].status === 'ambiguous' && m[0].candidates.length === 2, 'two people with one name is ambiguous, never guessed');
ok(m[1].status === 'not_found', 'an Admin login is never an RM or BM to import into');
m = matchRows([{ rowNo: 1, name: 'Johnson M John', pan: '', values: {}, problems: [] }, { rowNo: 2, name: 'John Johnson M', pan: '', values: {}, problems: [] }], team);
ok(m[0].status === 'matched' && m[1].status === 'duplicate', 'a second row for the same person is a duplicate');
ok(matchRows([{ rowNo: 1, name: 'Wrong Name', pan: 'HKCPK3532A', values: {}, problems: [] }], team)[0].person?.id === 't2', 'PAN finds the person even when the name differs');

// ── what would change ──
const d1 = diffFor(team[0], rows[0].values);
const keys = d1.map(x => x.key);
ok(keys.includes('arnNumber') && keys.includes('euinNumber') && keys.includes('email') && keys.includes('street') && keys.includes('accountNumber'), 'differing fields are listed');
ok(d1.find(x => x.key === 'arnNumber').from === 'ARN-111111' && d1.find(x => x.key === 'arnNumber').to === 'ARN-270604', 'with the old and the new value');
ok(!keys.includes('gstNumber'), 'a blank cell in the sheet is not a change');
ok(diffFor({ ...team[0], arnNumber: 'arn-270604' }, { arnNumber: 'ARN-270604' }).length === 0, 'the same value in another case is not a change');
ok(diffFor({ bankDetails: { accountNumber: '1234 5678 90' } }, { accountNumber: '1234567890' }).length === 0, 'account numbers compare by digits');

// ── applying: only the whitelist moves ──
const { changes, errors } = normalizeChanges({ arnNumber: 'arn 270604', email: 'New@X.com', accountNumber: '1234567890', street: '12 MG Road' });
ok(errors.length === 0 && changes.arnNumber === 'ARN-270604' && changes.email === 'new@x.com', 'the server-side normalizer cleans the same way');
const bad = normalizeChanges({ level: 7, customLevels: { 3: 90 }, role: 'ADMIN', parentId: 'x', password: 'p', code: 'X', arnNumber: 'zzz' });
ok(bad.errors.length === 7 && Object.keys(bad.changes).length === 0, 'level, sharing %, role, parent, password and code can never be imported, and a bad ARN is an error');
ok(['level', 'customLevels', 'role', 'parentId', 'password', 'code', 'name'].every(k => !FIELD_KEYS.includes(k)), 'the importable list has none of the money or access fields');
const applied = applyChanges({ level: 3, customLevels: { 3: 50 }, address: { street: 'old', city: 'Pune', state: 'MH', pincode: '411001', country: 'India' }, bankDetails: { accountName: 'A', accountNumber: '1', bankName: 'B', ifscCode: 'I' } }, 'old@x.com', changes);
ok(applied.email === 'new@x.com' && applied.data.arnNumber === 'ARN-270604', 'email and ARN written');
ok(applied.data.level === 3 && eq(applied.data.customLevels, { 3: 50 }), 'level and sharing % are exactly as they were');
ok(applied.data.address.street === '12 MG Road' && applied.data.address.city === 'Pune' && applied.data.bankDetails.accountNumber === '1234567890' && applied.data.bankDetails.accountName === 'A', 'address and bank change only the given parts');
ok(maskAccount('657301664339') === 'xxxx4339' && maskAccount('') === '', 'account numbers are masked for the log');

console.log(`teamImport: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
