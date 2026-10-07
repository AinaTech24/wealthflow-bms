/**
 * Restore the column names of a CAMS file that was exported in the old dBase style.
 *
 * CAMS sends the same statements two ways. The usual .xls has full lowercase headers
 * ("brkage_amt", "inv_name"). Some downloads — a \"July- 26 CAMS.xlsx\" made on 18 Aug
 * 2026 was one — come out as dBase: UPPERCASE and cut to 10 characters ("BRKAGE_AMT",
 * "INV_NAME", "BRKAGE_FRO", "PLOT_AMOUN"). The importer recognises a format by exact
 * header names, so that file matched nothing: every row loaded as investor "Unknown"
 * with ₹0 gross, and the brokerage window ("brkage_from") could not be found, so the
 * wrong-month check was blind as well.
 *
 * A header is restored only when it is an exact case-insensitive match of a known CAMS
 * column, or when it is exactly the first 10 characters of ONE known column (dBase
 * truncation). Anything else, and every non-CAMS file, is returned untouched.
 */
const CAMS_COLUMNS = ["amc_code","proc_date","folio_no","scheme_code","trxn_type","trxn_no","plot_amount","plot_units","post_date","trade_date_time","entry_date","user_code","user_trxnno","trxn_nature","ter_location","sys_reg_date","aut_txn_no","auto_amount","aut_txn_type","cease_date","remed_date","forf_date","src_brk_code","brok_code","brh_code","sub_brk_arn","ae_code","arn_emp_code","euin_opted","euin_valid","brk_comm_paid","adj_flag","brkage_type","brkage_rate","total_upfront","defer_frequency","defer_no_of_installment","pay_installment_no","brkage_amt","brkage_from","brkage_to","proc_from_date","proc_to_date","trxn_desc","spl_upf_tenure","upf_tenure_end_date","brk_pay_dt","clw_type","clw_period","rec_flag","p_si_date","rec_period","clw_amt","upf_paid","fee_id","am_code","am_comm","am_rate","avg_assets","cam_comm","cam_rate","mam_comm","mam_rate","no_of_days","orig_ae_code","orig_brh_code","orig_brk_code","rate_ref_id","ref_no","trxn_app_no","txn_sch_code","clw_prd","clw_required","p_si_mis_code","p_si_user_trxnno","seq_no","p_si_amt","p_si_tr_no","p_si_type","pur_si_units","remarks","to_scheme","trxn_sign","brk_posted","inv_name","brok_gst_state_code","igst_rate","cgst_rate","sgst_rate","igst_value","cgst_value","sgst_value","location_code","prev_folio","brok_category","p_scheme_code","p_trxn_type","p_trxn_no","p_folio_no","p_plot_amount","p_plot_units","folio_old","scheme_folio_number","amc_ref_no","request_ref_no","write_off_reason","hold_reason","brokerage_acrual_month","prev_trxn_no","prev_trxn_date","prodcode","scheme","trxntype","trxnno","trxnmode","trxnstat","usercode","usrtrxno","traddate","postdate","purprice","units","amount","brokcode","subbrok","brokperc","brokcomm","altfolio","rep_date","time1","trxnsubtyp","application_no","tax","total_tax","te_15h","micr_no","swflag","old_folio","reinvest_flag","mult_brok","stt","location","scheme_type","tax_status","load","scanrefno","pan","inv_iin","targ_src_scheme","trxn_type_flag","ticob_trtype","ticob_trno","ticob_posted_date","dp_id","trxn_charges","eligib_amt","src_of_txn","trxn_suffix","siptrxnno","euin","exch_dc_flag","sys_regn_date","ac_no","bank_name","reversal_code","exchange_flag","ca_initiated_date","gst_state_code","igst_amount","cgst_amount","sgst_amount","rev_remark","original_trxnno","stamp_duty","transmission_flag","foliochk","address1","address2","address3","city","pincode","product","sch_name","clos_bal","rupee_bal","jnt_name1","jnt_name2","phone_off","phone_res","email","holding_nature","uin_no","pan_no","joint1_pan","joint2_pan","guard_pan","broker_code","subbroker","reinv_flag","branch","ac_type","b_address1","b_address2","b_address3","b_city","b_pincode","inv_dob","mobile_no","occupation","nom_name","relation","nom_addr1","nom_addr2","nom_addr3","nom_city","nom_state","nom_pincode","nom_ph_off","nom_ph_res","nom_email","nom_percentage","nom2_name","nom2_relation","nom2_addr1","nom2_addr2","nom2_addr3","nom2_city","nom2_state","nom2_pincode","nom2_ph_off","nom2_ph_res","nom2_email","nom2_percentage","nom3_name","nom3_relation","nom3_addr1","nom3_addr2","nom3_addr3","nom3_city","nom3_state","nom3_pincode","nom3_ph_off","nom3_ph_res","nom3_email","nom3_percentage","ifsc_code","demat","guard_name","folio_date","aadhaar","tpa_linked","fh_ckyc_no","jh1_ckyc","jh2_ckyc","g_ckyc_no","jh1_dob","jh2_dob","guardian_dob","country","jh1_email","jh2_email","jh1_mobile_no","jh2_mobile_no"];

const byLower = new Map(CAMS_COLUMNS.map(c => [c.toLowerCase(), c]));

export function restoreCamsHeader(h) {
  const raw = String(h == null ? '' : h).trim();
  if (!raw) return raw;
  const lc = raw.toLowerCase();
  if (byLower.has(lc)) return byLower.get(lc);
  if (lc.length >= 8 && lc.length <= 10 && /^[a-z0-9_]+$/.test(lc)) {
    const hits = CAMS_COLUMNS.filter(c => c.length > 10 && c.slice(0, 10).toLowerCase() === lc);
    if (hits.length === 1) return hits[0];
  }
  return raw;
}

/**
 * Rewrite a header row. Only done when the row clearly IS a CAMS file (at least 12 of
 * its columns resolve to known CAMS names) so a Karvy or custom sheet is never touched.
 */
export function restoreCamsHeaders(row) {
  if (!Array.isArray(row)) return row;
  const next = row.map(restoreCamsHeader);
  const known = next.filter(h => byLower.has(String(h).toLowerCase())).length;
  return known >= 12 ? next.map((h, i) => (String(row[i] == null ? '' : row[i]).trim() === '' ? row[i] : h)) : row;
}
