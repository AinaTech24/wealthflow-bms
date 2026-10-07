// node src/lib/dbfHeaders.test.mjs
import { restoreCamsHeader, restoreCamsHeaders } from './dbfHeaders.js';
let pass = 0, fail = 0;
const eq = (a, b, w) => { if (a === b) pass++; else { fail++; console.log('  FAIL  ' + w + ': got ' + a + ', want ' + b); } };

// The July- 26 CAMS.xlsx dBase export: UPPERCASE, cut to 10 characters.
eq(restoreCamsHeader('BRKAGE_AMT'), 'brkage_amt', 'exact 10-char, upper-case');
eq(restoreCamsHeader('INV_NAME'), 'inv_name', 'short name');
eq(restoreCamsHeader('BRKAGE_FRO'), 'brkage_from', 'truncated window start');
eq(restoreCamsHeader('PLOT_AMOUN'), 'plot_amount', 'truncated amount');
eq(restoreCamsHeader('SCHEME_COD'), 'scheme_code', 'truncated scheme code');
eq(restoreCamsHeader('PREV_TRXN_'), 'PREV_TRXN_', 'ambiguous truncation is left alone');
eq(restoreCamsHeader('Investor Name'), 'Investor Name', 'Karvy header untouched');
eq(restoreCamsHeader('Brokerage (in Rs.)'), 'Brokerage (in Rs.)', 'Karvy brokerage untouched');
eq(restoreCamsHeader(''), '', 'blank');

const dbf = ['AMC_CODE','PROC_DATE','FOLIO_NO','SCHEME_COD','TRXN_TYPE','TRXN_NO','PLOT_AMOUN','PLOT_UNITS','POST_DATE','TRADE_DATE','USER_CODE','BRKAGE_AMT','BRKAGE_FRO','BRKAGE_TO','INV_NAME'];
const out = restoreCamsHeaders(dbf);
eq(out.includes('brkage_amt') && out.includes('folio_no') && out.includes('post_date') && out.includes('inv_name'), true, 'a dBase CAMS header row is restored');

const karvy = ['Product Code', 'Fund', 'Account Number', 'Brokerage (in Rs.)', 'Investor Name'];
eq(restoreCamsHeaders(karvy), karvy, 'a Karvy header row is returned as-is');
const real = ['amc_code','proc_date','folio_no','scheme_code','trxn_type','trxn_no','plot_amount','plot_units','post_date','trade_date_time','entry_date','user_code','brkage_amt'];
eq(restoreCamsHeaders(real).join(), real.join(), 'a normal lowercase CAMS file is unchanged');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
