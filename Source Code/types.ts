
export enum Role {
  ADMIN = 'ADMIN',
  FINANCE = 'FINANCE',
  OPS = 'OPS',
  VIEWER = 'VIEWER'
}

export enum TransactionSource {
  // Brokerage-only statements (codes, no PAN)
  CAMS = 'CAMS',
  KFINTECH = 'KFINTECH',
  KARVY = 'KARVY',
  // Full transaction reports — include PAN + full scheme/AMC names + brokerage
  CAMS_WBR2 = 'CAMS_WBR2',          // CAMS "Customer Service" transaction file
  KARVY_MFSD201 = 'KARVY_MFSD201',  // KFintech transactions
  // Folio master files — investor master, no transactions
  CAMS_WBR9 = 'CAMS_WBR9',          // CAMS folio master (investor static + balances)
  KARVY_MFSD211 = 'KARVY_MFSD211',  // KFintech folio master
}

/** Master-only sources upsert clients without creating transactions. */
export const MASTER_SOURCES: TransactionSource[] = [
  TransactionSource.CAMS_WBR9,
  TransactionSource.KARVY_MFSD211,
];

export enum TransactionStatus {
  DRAFT = 'DRAFT',
  VALIDATED = 'VALIDATED',
  APPROVED = 'APPROVED',
  PAID = 'PAID'
}

export enum InvoiceStatus {
  UNBILLED = 'UNBILLED',
  SUBMITTED = 'SUBMITTED', // Raised by user, awaiting approval
  APPROVED = 'APPROVED',   // Approved by admin/finance, pending settlement
  PAID = 'PAID',           // Settled
  REJECTED = 'REJECTED'
}

export interface BankDetails {
  accountName: string;
  accountNumber: string;
  bankName: string;
  ifscCode: string;
  branch?: string;
}

export interface Address {
  street: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

export interface TeamMember {
  id: string;
  name: string;
  code: string; // ARN or Emp Code
  role: Role;
  level: number; // 1-7, where 7 is highest (Super Holding) and 1 is lowest (Relationship Manager)
  email?: string;
  password?: string; // Mock password
  parentId?: string; // High-level parent/manager
  gstNumber?: string; // Optional for invoicing
  pan?: string;       // RM's PAN (printed on the tax invoice)
  signature?: string; // Base64 data-URL of the RM's signature image — auto-embedded above "Authorised Signatory" on their invoices
  bankDetails?: BankDetails;
  address?: Address;
  // Additional levels this user is allowed to hold across different clients.
  // `level` remains the primary designation; `roles` (if set) lists every level
  // they can be assigned to in client hierarchies (e.g. [1,3,4,5]). Empty/absent
  // → only their single `level` applies.
  roles?: number[];
  customLevels?: { // User-specific sharing override
    1?: number;
    2?: number;
    3?: number;
    4?: number;
    5?: number;
    6?: number;
    7?: number;
  };
  // Effective-dated rate timeline. A promotion / rate change must apply from its
  // effective month FORWARD only — without this, re-grading someone silently
  // restated every historical month (including already-invoiced ones) at the new
  // rate. Written by the server on save; entries are sorted oldest-first and the
  // engines pick the one in force during each transaction's brokerage period.
  // Absent => the member has never been re-graded; current values apply throughout.
  rateHistory?: Array<{
    effectiveFrom: string;                 // 'YYYY-MM' ('0000-01' = since inception)
    level?: number;
    customLevels?: TeamMember['customLevels'];
  }>;
  // Write-only control field: the month a rate/level edit takes effect. Consumed
  // by the server to stamp rateHistory, never persisted.
  rateEffectiveFrom?: string;
  // SEBI/AMFI compliance fields
  arnNumber?: string;       // ARN code (e.g., "ARN-12345")
  arnValidTill?: string;    // ISO date — distributor registration expiry
  euinNumber?: string;      // EUIN code (e.g., "E123456")
  euinValidTill?: string;   // ISO date — EUIN expiry
}

export interface SharingConfig {
  id: string;
  name: string;
  companyExpensePct: number; // e.g. 15 for 15%
  /**
   * Flat % of the firm's partner-brokerage share that reaches the mapped client's
   * RM, keyed by partner code (e.g. { MOFSL: 30 }).
   *
   * Broking is a different business from mutual fund trail and its statement
   * carries no RM dimension at all — every row is one branch — so this cannot be
   * derived from the level ladder above. It is set deliberately per partner.
   */
  partnerSharing?: Record<string, number | Record<string, number>>;
  levels: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
    6: number;
    7: number;
  };
  levelNames: {
    1: string;
    2: string;
    3: string;
    4: string;
    5: string;
    6: string;
    7: string;
  };
  scope: 'GLOBAL' | 'CLIENT' | 'CATEGORY' | 'USER';
  scopeId?: string; // ClientID or CategoryID or UserID
  // Firm-level fields used for GST split — same state = CGST+SGST, different = IGST.
  firmName?: string;
  firmState?: string;     // e.g. "Maharashtra"
  firmGstin?: string;
  firmPan?: string;
  // Company ("Bill To") details printed on every RM tax invoice — the RM raises
  // the invoice TO the company. Editable in Settings so they are never hard-coded.
  firmAddressLine1?: string;   // e.g. "Flat No B-404, Valencia Building, Bhakti Park"
  firmAddressLine2?: string;   // e.g. "Wadala East, Antop Hill, Mumbai - 400037"
  firmStateCode?: string;      // GST state code, e.g. "27" for Maharashtra
  // Where the company pays the RM (shown under Bank Details on the invoice). If a
  // per-RM bankDetails snapshot exists it takes precedence; this is the fallback.
  firmBankName?: string;
  firmBankAccount?: string;
  firmBankIfsc?: string;
  firmBankBranch?: string;
  companySeal?: string;        // Base64 data-URL of an optional company stamp/seal
  defaultHsnSac?: string;      // Default HSN/SAC for the brokerage line, e.g. "997152"
  defaultTdsRate?: number;     // Default TDS % applied on new invoices, e.g. 2
  defaultGstRate?: number;     // GST % used when the RM has a GSTIN, e.g. 18
  // ── Lead-Source Sharing Matrix ──────────────────────────────────────────
  // Keyed by the LEVEL that originated/referred the lead (1..7). Each row maps
  // level → % of GROSS that level receives for clients whose lead came from that
  // source level. Company retention = residue. When a client has a leadSourceLevel
  // AND a matching row exists here, this row overrides the owner-driven split.
  // Absent / unset → calculation falls back to the existing owner-driven model.
  leadSourceMatrix?: Record<number, Partial<Record<number, number>>>;
  // ── Cumulative Designation Model (lead-source aware) ────────────────────
  // When leadSharingModel === 'CUMULATIVE', payouts use designationCumulative
  // (cumulative % per level, e.g. {1:25,2:50,3:75,4:85,5:90,6:95}) plus a flat
  // leadSourcePct seeded to whoever sourced the lead. Otherwise the % -of-gross
  // ("SLICES") model is used.
  leadSharingModel?: 'SLICES' | 'CUMULATIVE';
  designationCumulative?: Partial<Record<number, number>>;
  leadSourcePct?: number;
  // Folios that belong to no client record: the importer never matches or creates a client for them. Server-owned (kept on config save).
  folioBlocklist?: string[];
}

export interface Client {
  id: string;
  pan: string;
  name: string;
  email?: string;
  mobile?: string;
  folios: string[];
  hierarchy: {
    level1Id: string;
    level2Id: string;
    level3Id: string;
    level4Id: string;
    level5Id: string;
    level6Id: string;
    level7Id: string;
  };
  // Which hierarchy level (1..7) originated/referred this client's lead. Drives
  // the Lead-Source Sharing Matrix. Unset → treated as self-sourced (lowest
  // assigned level) = existing owner-driven behaviour.
  leadSourceLevel?: number;
  // ── AUM / holdings (populated by CAMS WBR9 master imports; partially by
  //    brokerage statements as `avg_assets`-derived estimates when WBR9 absent).
  totalAum?: number;                  // sum of all per-folio rupee balances
  aumAsOf?: string;                   // ISO date of the latest snapshot used
  aumSource?: 'WBR9' | 'ESTIMATED';   // WBR9 = exact snapshot, ESTIMATED = derived from brokerage avg_assets
  holdings?: ClientHolding[];         // per-folio × scheme breakdown
}

export interface ClientHolding {
  folio: string;
  amcName: string;
  schemeName: string;
  units?: number;                     // current unit balance (WBR9 only)
  aumValue: number;                   // rupee value (rupee_bal from WBR9, or estimated)
  asOfDate: string;                   // ISO date
  source: 'WBR9' | 'ESTIMATED';
}

export interface MappingEntry {
  original: string;
  standard: string;
}

export interface PayoutBreakdown {
  gross: number;
  expenseAmount: number;
  netPool: number;
  levelPayouts: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
    6: number;
    7: number;
  };
  userPayouts?: Record<string, number>; // Mapping of userId -> amount
}

export interface BrokerageTransaction {
  id: string;
  batchId: string;
  source: TransactionSource;
  uploadDate: string;
  transactionDate: string;
  brokeragePeriod: string; // Format: "YYYY-MM"
  folio: string;
  pan: string;
  investorName: string;
  amcName: string;
  schemeName: string;
  category: string; // Equity, Debt
  grossAmount: number;
  currentValue?: number;
  brokerageRate?: number;
  mappedClientId?: string; // Null if unmapped
  status: TransactionStatus;
  breakdown?: PayoutBreakdown;
  remarks?: string;
  // Derived transaction type — inferred from remarks/trxn_desc during import.
  transactionType?: TransactionType;
  // Preview-only compliance flags (not persisted to DB).
  _flags?: ImportFlag[];
}

export type TransactionType =
  | 'SIP'            // Systematic Investment Plan
  | 'STP'            // Systematic Transfer Plan
  | 'SWP'            // Systematic Withdrawal Plan
  | 'LUMPSUM'        // One-time purchase
  | 'REDEMPTION'     // Sell / liquidate
  | 'SWITCH_IN'      // Switch from another scheme
  | 'SWITCH_OUT'     // Switch to another scheme
  | 'DIVIDEND'       // Dividend reinvest / payout
  | 'BONUS'          // Bonus units
  | 'OTHER';

export type ImportFlag =
  | 'DUPLICATE'           // matches an existing transaction by PAN/folio + scheme + month + amount
  | 'SEBI_CAP_WARNING'    // effective rate exceeds expected SEBI/AMC cap for category
  | 'MISSING_PAN'         // no PAN supplied — common for CAMS brokerage statements
  | 'UNMAPPED_CLIENT';    // could not be linked to any client

export interface ImportBatch {
  id: string;
  fileName: string;
  uploadDate: string;
  status: TransactionStatus;
  totalLines: number;
  totalGross: number;
  unmappedCount: number;
  // Soft-delete support — set when batch is moved to trash. Cleared on restore.
  deletedAt?: string;
  deletedBy?: string;
}

export interface PayoutInvoice {
  id: string;
  userId: string;
  userName: string;
  userRole: string;
  month: string; // YYYY-MM
  amount: number;
  status: InvoiceStatus;
  submittedDate?: string;
  paidDate?: string;
  transactionCount: number;
  bankSnapshot?: BankDetails;
  addressSnapshot?: Address;
  // Tax fields
  gstEnabled?: boolean;
  gstRate?: number;       // e.g. 18 for 18%
  gstAmount?: number;     // Computed: amount * gstRate / 100  (total GST)
  // GST split — set when gstEnabled. Same-state = CGST+SGST (each rate/2), inter-state = IGST.
  gstSplit?: 'INTRA' | 'INTER';
  cgstRate?: number;
  cgstAmount?: number;
  sgstRate?: number;
  sgstAmount?: number;
  igstRate?: number;
  igstAmount?: number;
  tdsEnabled?: boolean;
  tdsRate?: number;       // e.g. 10 for 10%
  tdsAmount?: number;     // Computed: amount * tdsRate / 100
  netPayable?: number;    // amount + gstAmount - tdsAmount
  gstNumber?: string;     // GST of the payee
  invoiceNumber?: string; // Sequential invoice number
  invoiceDate?: string;
  hsnSac?: string;        // HSN/SAC code for the brokerage line (snapshot at raise time)
  roundOff?: number;      // Round-off applied to reach a whole-rupee total (Tally style)
  signatureSnapshot?: string; // RM signature image captured at raise time
  sellerGstin?: string;   // RM GSTIN snapshot
  sellerPan?: string;     // RM PAN snapshot
  sellerState?: string;   // RM state snapshot (for the GST intra/inter split)
  // Approval workflow audit trail
  approvedDate?: string;
  approvedBy?: string;     // user id
  approvedByName?: string;
  rejectedDate?: string;
  rejectedBy?: string;
  rejectedByName?: string;
  rejectionReason?: string;
}
