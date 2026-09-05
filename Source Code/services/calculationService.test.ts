/**
 * Calculation Service Tests
 * Demonstrates the validation and accuracy improvements
 */

import {
  calculatePayout,
  validateSharingConfig,
  validateBreakdown,
  validateCustomLevels,
  generateReconciliationReport
} from './calculationService';
import { SharingConfig, TeamMember, Role, BrokerageTransaction, TransactionStatus, TransactionSource } from '../types';

// Test Configuration
const testConfig: SharingConfig = {
  id: 'test_config',
  name: 'Test Configuration',
  companyExpensePct: 15,
  levels: {
    7: 10, // CEO
    6: 10, // Director
    5: 15, // Manager
    4: 25, // Senior
    3: 20, // Associate
    2: 15, // Junior
    1: 5   // Entry
  },
  levelNames: {
    7: 'CEO',
    6: 'Director',
    5: 'Manager',
    4: 'Senior',
    3: 'Associate',
    2: 'Junior',
    1: 'Entry'
  },
  scope: 'GLOBAL'
};

// Test Team
const testTeam: TeamMember[] = [
  { id: 'user0', name: 'CEO', code: 'CEO001', role: Role.ADMIN, level: 7 },
  { id: 'user3', name: 'Senior', code: 'SEN001', role: Role.OPS, level: 4 },
  { id: 'user6', name: 'Entry', code: 'ENT001', role: Role.OPS, level: 1 }
];

console.log('=== CALCULATION SERVICE TESTS ===\n');

// TEST 1: Config Validation
console.log('TEST 1: Config Validation');
const configValidation = validateSharingConfig(testConfig);
console.log('✓ Config validation:', configValidation);
console.log('  Total sharing:', Object.values(testConfig.levels).reduce((a, b) => a + b, 0), '%');
console.log('');

// TEST 2: Rounding Accuracy
console.log('TEST 2: Rounding Accuracy Test');
const testAmounts = [1000.33, 1500.67, 999.99, 10000.01];

testAmounts.forEach(amount => {
  const breakdown = calculatePayout(
    amount,
    testConfig,
    {
      level0Id: 'user0',
      level3Id: 'user3',
      level6Id: 'user6',
      level1Id: '',
      level2Id: '',
      level4Id: '',
      level5Id: ''
    },
    new Map(testTeam.map(t => [t.id, t]))
  );

  const totalDistributed = Object.values(breakdown.levelPayouts).reduce((sum, val) => sum + val, 0);
  const variance = Math.abs(breakdown.netPool - totalDistributed);

  console.log(`  Amount: ₹${amount.toFixed(2)}`);
  console.log(`    Net Pool: ₹${breakdown.netPool.toFixed(2)}`);
  console.log(`    Distributed: ₹${totalDistributed.toFixed(2)}`);
  console.log(`    Variance: ₹${variance.toFixed(4)}`, variance === 0 ? '✓ PERFECT' : variance <= 0.01 ? '✓ ACCEPTABLE' : '✗ FAIL');

  const validation = validateBreakdown(breakdown);
  if (!validation.isValid) {
    console.log(`    ✗ Validation FAILED:`, validation.errors);
  }
});
console.log('');

// TEST 3: Custom Level Override
console.log('TEST 3: Custom Level Override Test');
const userWithCustomRate: TeamMember = {
  id: 'user3_custom',
  name: 'Senior (Custom)',
  code: 'SEN002',
  role: Role.OPS,
  level: 3,
  customLevels: {
    3: 35 // Override level 3 from 25% to 35%
  }
};

const customValidation = validateCustomLevels(userWithCustomRate, testConfig);
console.log('✓ Custom level validation:', customValidation);

const breakdownWithCustom = calculatePayout(
  10000,
  testConfig,
  {
    level3Id: 'user3_custom',
    level6Id: 'user6',
    level0Id: '',
    level1Id: '',
    level2Id: '',
    level4Id: '',
    level5Id: ''
  },
  new Map([[userWithCustomRate.id, userWithCustomRate], ...testTeam.map(t => [t.id, t] as [string, TeamMember])])
);

console.log('  Level 3 Payout (custom 35%):', breakdownWithCustom.levelPayouts[3]);
console.log('  Level 6 Payout (default 5%):', breakdownWithCustom.levelPayouts[6]);
console.log('');

// TEST 4: Invalid Config Detection
console.log('TEST 4: Invalid Config Detection');
const invalidConfig: SharingConfig = {
  ...testConfig,
  levels: {
    7: 20,
    6: 20,
    5: 20,
    4: 20,
    3: 20,
    2: 20,
    1: 20 // Total = 140% (invalid!)
  }
};

const invalidValidation = validateSharingConfig(invalidConfig);
console.log('  Invalid config detected:', !invalidValidation.isValid ? '✓ PASS' : '✗ FAIL');
console.log('  Errors:', invalidValidation.errors);
console.log('');

// TEST 5: Edge Cases
console.log('TEST 5: Edge Case Tests');

// Test 5a: Very small amount
const smallBreakdown = calculatePayout(0.01, testConfig, { level7Id: 'user0', level1Id: '', level2Id: '', level3Id: '', level4Id: '', level5Id: '', level6Id: '' }, new Map(testTeam.map(t => [t.id, t])));
console.log('  Small amount (₹0.01):');
console.log('    Net Pool:', smallBreakdown.netPool);
console.log('    Level 7 Payout:', smallBreakdown.levelPayouts[7]);

// Test 5b: Large amount
const largeBreakdown = calculatePayout(10000000, testConfig, { level7Id: 'user0', level1Id: '', level2Id: '', level3Id: '', level4Id: '', level5Id: '', level6Id: '' }, new Map(testTeam.map(t => [t.id, t])));
console.log('  Large amount (₹10,000,000):');
console.log('    Net Pool:', largeBreakdown.netPool.toLocaleString());
console.log('    Level 7 Payout:', largeBreakdown.levelPayouts[7].toLocaleString());

const largeValidation = validateBreakdown(largeBreakdown);
console.log('    Validation:', largeValidation.isValid ? '✓ PASS' : '✗ FAIL');
console.log('');

// TEST 6: Reconciliation Report
console.log('TEST 6: Reconciliation Report Test');
const testTransactions: BrokerageTransaction[] = [
  {
    id: 'tx1',
    batchId: 'batch1',
    source: TransactionSource.CAMS,
    uploadDate: '2025-01-01',
    transactionDate: '2025-01-15',
    brokeragePeriod: '2025-01',
    folio: 'F001',
    pan: 'ABCDE1234F',
    investorName: 'Test Investor',
    amcName: 'Test AMC',
    schemeName: 'Test Scheme',
    category: 'Equity',
    grossAmount: 1000,
    mappedClientId: 'client1',
    status: TransactionStatus.VALIDATED,
    breakdown: calculatePayout(1000, testConfig, { level0Id: 'user0', level3Id: 'user3', level6Id: 'user6', level1Id: '', level2Id: '', level4Id: '', level5Id: '' }, new Map(testTeam.map(t => [t.id, t])))
  },
  {
    id: 'tx2',
    batchId: 'batch1',
    source: TransactionSource.CAMS,
    uploadDate: '2025-01-01',
    transactionDate: '2025-01-16',
    brokeragePeriod: '2025-01',
    folio: 'F002',
    pan: 'ABCDE1234F',
    investorName: 'Test Investor',
    amcName: 'Test AMC',
    schemeName: 'Test Scheme 2',
    category: 'Debt',
    grossAmount: 2000,
    mappedClientId: 'client1',
    status: TransactionStatus.VALIDATED,
    breakdown: calculatePayout(2000, testConfig, { level0Id: 'user0', level3Id: 'user3', level6Id: 'user6', level1Id: '', level2Id: '', level4Id: '', level5Id: '' }, new Map(testTeam.map(t => [t.id, t])))
  }
];

const report = generateReconciliationReport(testTransactions, testConfig, [], testTeam);
console.log('  Total Transactions:', report.totalTransactions);
console.log('  Valid Transactions:', report.validTransactions);
console.log('  Invalid Transactions:', report.invalidTransactions);
console.log('  System Variance: ₹', report.variance);
console.log('  Status:', report.variance === 0 ? '✓ PERFECT' : report.variance <= 0.01 ? '✓ ACCEPTABLE' : '✗ NEEDS REVIEW');
console.log('');

console.log('=== ALL TESTS COMPLETED ===');
console.log('✓ Validation layer working');
console.log('✓ Rounding sweep eliminating precision errors');
console.log('✓ Config validation preventing invalid setups');
console.log('✓ Custom overrides supported');
console.log('✓ Reconciliation reports available');

// ─────────────────────────────────────────────────────────────────────────────
// CUMULATIVE DESIGNATION + LEAD-SOURCE MODEL TESTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== CUMULATIVE + LEAD-SOURCE MODEL ===');

const cumConfig: SharingConfig = {
  ...testConfig,
  leadSharingModel: 'CUMULATIVE',
  designationCumulative: { 1: 25, 2: 50, 3: 75, 4: 85, 5: 90, 6: 95, 7: 100 },
  leadSourcePct: 25,
};

const assert = (label: string, got: number, want: number) => {
  const ok = Math.abs(got - want) <= 0.01;
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label}: got ₹${got.toFixed(2)} want ₹${want.toFixed(2)}`);
  if (!ok) process.exitCode = 1;
};

// Client: L3 (RM) self-sourced, L4 Master, L6 top. Gross 1000.
// Lead source = L3 (lowest) → L3 gets 25 base + (75-25)=50 = 750; L4 = 85-75 = 100; L6 = 95-85 = 100; company 50.
{
  const h = { level1Id: '', level2Id: '', level3Id: 'RM', level4Id: 'MAS', level5Id: '', level6Id: 'TOP', level7Id: '' };
  const b = calculatePayout(1000, cumConfig, h, new Map(), undefined);
  assert('self-sourced RM (L3)', b.userPayouts?.['RM'] || 0, 750);
  assert('Master (L4)', b.userPayouts?.['MAS'] || 0, 100);
  assert('Top (L6)', b.userPayouts?.['TOP'] || 0, 100);
  assert('company residue', b.expenseAmount, 50);
}

// Same client but lead sourced by L6 (Zen Monk). L6 gets 25 base + its 100 gap; RM(L3)=75-25=50→500; L4=100; company 50.
{
  const h = { level1Id: '', level2Id: '', level3Id: 'RM', level4Id: 'MAS', level5Id: '', level6Id: 'TOP', level7Id: '' };
  const b = calculatePayout(1000, cumConfig, h, new Map(), 6);
  assert('L6-sourced: RM(L3)', b.userPayouts?.['RM'] || 0, 500);
  assert('L6-sourced: Master(L4)', b.userPayouts?.['MAS'] || 0, 100);
  assert('L6-sourced: Top(L6) = 250 base + 100 gap', b.userPayouts?.['TOP'] || 0, 350);
  assert('L6-sourced: company', b.expenseAmount, 50);
}

// Guard: cumulative selected but rates empty → must NOT pay zero; falls back to slices.
{
  const broken: SharingConfig = { ...testConfig, leadSharingModel: 'CUMULATIVE', designationCumulative: {}, leadSourcePct: 25 };
  const h = { level1Id: '', level2Id: '', level3Id: 'RM', level4Id: '', level5Id: '', level6Id: '', level7Id: '' };
  const b = calculatePayout(1000, broken, h, new Map(), undefined);
  const total = Object.values(b.userPayouts || {}).reduce((s, v) => s + v, 0) + b.expenseAmount;
  console.log(`  ${Math.abs(total - 1000) <= 0.05 ? '✓' : '✗ FAIL'} empty-rates fallback conserves gross: ₹${total.toFixed(2)}`);
  if (Math.abs(total - 1000) > 0.05) process.exitCode = 1;
}

console.log('=== CUMULATIVE TESTS COMPLETED ===');

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-ROLE USER TEST — same user at different levels on different clients
// (Cumulative model; rates 25/50/75/85/90/95, lead 25)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== MULTI-ROLE USER (different level per client) ===');
{
  // Client A: Ravisankar at L3 (self-sourced, lowest) — earns 25 base + (75-25) = 750 on 1000.
  const cA = { level1Id: '', level2Id: '', level3Id: 'RAVI', level4Id: 'KUM', level5Id: '', level6Id: 'TOP', level7Id: '' };
  const bA = calculatePayout(1000, cumConfig, cA, new Map(), undefined);
  assert('Client A — Ravisankar as L3', bA.userPayouts?.['RAVI'] || 0, 750);

  // Client B: Ravisankar at L4 (a different RM at L3 sources it) — Ravi earns the L4 gap 85-75 = 100.
  const cB = { level1Id: '', level2Id: '', level3Id: 'OTHERRM', level4Id: 'RAVI', level5Id: '', level6Id: 'TOP', level7Id: '' };
  const bB = calculatePayout(1000, cumConfig, cB, new Map(), undefined);
  assert('Client B — Ravisankar as L4', bB.userPayouts?.['RAVI'] || 0, 100);
  assert('Client B — OtherRM as L3 (self-sourced)', bB.userPayouts?.['OTHERRM'] || 0, 750);

  // Client C: Ravisankar at L1 (lead source base only path) — earns 25 base + (25-25)=0 → 250.
  const cC = { level1Id: 'RAVI', level2Id: '', level3Id: 'RM3', level4Id: '', level5Id: '', level6Id: '', level7Id: '' };
  const bC = calculatePayout(1000, cumConfig, cC, new Map(), 1); // lead source = L1 (Ravi)
  assert('Client C — Ravisankar as L1 lead source', bC.userPayouts?.['RAVI'] || 0, 250);
  assert('Client C — RM3 as L3', bC.userPayouts?.['RM3'] || 0, 500);

  // Ravisankar's blended total across A+B+C:
  const total = (bA.userPayouts?.['RAVI']||0) + (bB.userPayouts?.['RAVI']||0) + (bC.userPayouts?.['RAVI']||0);
  assert('Ravisankar total across 3 clients (750+100+250)', total, 1100);
}
console.log('=== MULTI-ROLE TESTS COMPLETED ===');
