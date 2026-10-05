// Tests for the investor-name agreement rule.
//
//   node src/lib/nameMatch.test.mjs
//
// WHY THIS EXISTS
// This rule decides whose client a folio's money belongs to. Loosen it and
// ₹1,137.10 a month goes back to leaking from RAVISANKAR K K and Vinubhai
// Nathubhai Desai onto Mahek Haresh Chugh; tighten it and real rows stop being
// attributed and quietly reach nobody. Both failures are money, so every case
// below is a real name from this book.
import { nameContradicts, nameTokens } from './nameMatch.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL  ${what}`); } };

/** Names that are the SAME person — must never be treated as a contradiction. */
const same = (a, b) => ok(!nameContradicts(a, b), `should agree: "${a}" vs "${b}"`);
/** Names that are DIFFERENT people — the folio must not carry one onto the other. */
const differ = (a, b) => ok(nameContradicts(a, b), `should contradict: "${a}" vs "${b}"`);

console.log('\nnameMatch — the same person, written differently');
same('J THILAK (HUF)', 'J THILAK (HUF)  ');                  // trailing space: 15% of rows carry one
same('RAJESH KUMAR JAISWAL', 'Rajesh Kumar Jaiswal');        // case only
same('Girishkumar Ramjibhai Desai', 'GIRISHKUMAR R DESAI');  // middle name abbreviated
same('Anand G Tarasinghani HUF', 'ANAND G TARASINGHANI (HUF)');
same('MANASVEE VINUBHAI DESAI', 'MANASVEE VINUBHAI DESAI REP BY FORAM VINUBHAI DESAI');
same('Monesh Hareshlal Keswani', 'MONESH HARESHLAL');

console.log('\nnameMatch — the six investors that one record had collected');
// Every one of these was filed under "Amit Parshotam Menghani" in August.
for (const other of [
  'J THILAK (HUF)',
  'Girishkumar Ramjibhai Desai',
  'Poosari Kannan Hari Kanjivan',
  'MANASVEE VINUBHAI DESAI',
  'Aaradhay Singh',
  'Monesh Hareshlal',
]) differ('Amit Parshotam Menghani', other);

console.log('\nnameMatch — a shared stop-word is not a match');
differ('RAJESH KUMAR', 'SURESH KUMAR');          // "KUMAR" is half the book
differ('Sunita Devi', 'Kamla Devi');
differ('MR AMIT SHAH', 'MRS PRIYA VERMA');

console.log('\nnameMatch — judge nothing on no evidence');
// A blank or unreadable name must leave the caller's existing behaviour alone,
// never discard a row. It answers "definitely someone else?", not "same person?".
ok(!nameContradicts('', 'Amit Parshotam Menghani'), 'blank name must not contradict');
ok(!nameContradicts('Amit Parshotam Menghani', ''), 'blank investor must not contradict');
ok(!nameContradicts('A B C', 'X Y Z'), 'initials only — no tokens, must not contradict');
ok(!nameContradicts('KUMAR', 'DEVI'), 'only stop-words — must not contradict');
ok(!nameContradicts('123456', 'Amit Menghani'), 'digits only — must not contradict');

console.log('\nnameMatch — tokens');
ok(!nameTokens('MR A KUMAR').size, 'honorific, initial and stop-word leave nothing');
ok(nameTokens('J THILAK (HUF)').has('THILAK'), 'keeps the identifying word');
ok(!nameTokens('J THILAK (HUF)').has('HUF'), 'drops the suffix');
ok(!nameTokens('MANASVEE DESAI REP BY FORAM DESAI').has('FORAM'), 'drops the representative');
ok(nameTokens('MANASVEE DESAI REP BY FORAM DESAI').has('MANASVEE'), 'keeps the investor');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
