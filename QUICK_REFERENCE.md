# Calculation System - Quick Reference Card

## 🚀 Quick Start

### Run Server
```bash
npm start
# Server starts on port 3000
# Database constraints added automatically
```

### Check System Health
```bash
curl http://localhost:3000/api/calculations/reconciliation
```

---

## 📡 API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/calculations/verify` | POST | Verify single transaction |
| `/api/calculations/reconciliation` | GET | System health report |
| `/api/calculations/cleanup-duplicates` | POST | Remove duplicates |

---

## 💻 Code Snippets

### Validate Config
```typescript
import { validateSharingConfig } from './services/calculationService';

const result = validateSharingConfig(config);
if (!result.isValid) {
  alert(result.errors.join('\n'));
}
```

### Validate Breakdown
```typescript
import { validateBreakdown } from './services/calculationService';

const breakdown = calculatePayout(...);
const check = validateBreakdown(breakdown);
console.log(check.isValid ? '✓' : '✗', check);
```

### Proper Rounding
```typescript
// ❌ Wrong
const amount = parseFloat((1000.33).toFixed(2));

// ✅ Correct
const amount = Math.round(1000.33 * 100) / 100;
```

### Calculate Tax
```typescript
import { calculatePercentage, roundAmount } from './utils/calculationValidation';

const base = roundAmount(10000);           // ₹10,000.00
const gst = calculatePercentage(base, 18); // ₹1,800.00
const tds = calculatePercentage(base, 10); // ₹1,000.00
const net = roundAmount(base + gst - tds); // ₹10,800.00
```

---

## 🧪 Testing

### Run Tests
```bash
npx ts-node "Source Code/services/calculationService.test.ts"
```

### Expected Output
```
=== CALCULATION SERVICE TESTS ===
TEST 1: Config Validation ✓
TEST 2: Rounding Accuracy ✓
TEST 3: Custom Override ✓
TEST 4: Invalid Config ✓
TEST 5: Edge Cases ✓
TEST 6: Reconciliation ✓
```

---

## 🔍 Troubleshooting

### Issue: Variance detected
```bash
# 1. Check report
curl http://localhost:3000/api/calculations/reconciliation

# 2. If variance > 0.01, check logs
grep "validation" server.log
```

### Issue: Duplicate entries
```bash
# Clean up duplicates
curl -X POST http://localhost:3000/api/calculations/cleanup-duplicates \
  -H "Authorization: Bearer TOKEN"
```

### Issue: Invalid config
```typescript
// Validate before saving
const validation = validateSharingConfig(config);
if (!validation.isValid) {
  console.error(validation.errors);
  return; // Don't save
}
```

---

## ✅ Health Check Checklist

Daily:
- [ ] No validation errors in logs

Weekly:
- [ ] Check `/api/health` endpoint
- [ ] Verify new transactions calculate correctly

Monthly:
- [ ] Run reconciliation report
- [ ] Verify system variance = 0
- [ ] Check for duplicate entries

---

## 📞 Emergency Contacts

**If variance > ₹1.00:**
1. Stop processing new transactions
2. Run reconciliation report
3. Check specific failing transactions
4. Review recent config changes

**If duplicates found:**
1. Run cleanup endpoint
2. Verify constraint is active
3. Check for race conditions

---

## 🎯 Key Metrics

| Metric | Target | Warning | Critical |
|--------|--------|---------|----------|
| System Variance | ₹0.00 | ≤₹0.10 | >₹1.00 |
| Valid % | 100% | ≥99% | <99% |
| Calculation Time | <50ms | <100ms | >200ms |
| Duplicates | 0 | 0 | >0 |

---

## 📚 Documentation

- **Full Docs:** `CALCULATION_IMPROVEMENTS.md`
- **Summary:** `IMPLEMENTATION_SUMMARY.md`
- **This Card:** `QUICK_REFERENCE.md`

---

## 🔢 Formula Reference

### Payout Calculation
```
Expense = Gross × (ExpensePct / 100)
NetPool = Gross - Expense
LevelPayout[L] = NetPool × (LevelPct[L] / 100)
```

### With Rounding Sweep
```
TotalDistributed = Σ LevelPayout[L]
Variance = NetPool - TotalDistributed
LevelPayout[Highest] += Variance (if |Variance| ≤ 0.10)
```

### Tax Calculation
```
GST = Base × GSTRate / 100
TDS = Base × TDSRate / 100
NetPayable = Base + GST - TDS
```

---

## 💡 Best Practices

1. **Always validate** configs before saving
2. **Always check** breakdown after calculation
3. **Use utilities** from `calculationValidation.ts`
4. **Run reconciliation** monthly
5. **Monitor logs** for warnings

---

## 🎓 Common Patterns

### Creating Transaction
```typescript
const breakdown = calculatePayout(gross, config, hierarchy, team);
const validation = validateBreakdown(breakdown);

if (validation.isValid) {
  // Save transaction with breakdown
} else {
  // Log errors and retry
  console.error(validation.errors);
}
```

### Raising Invoice
```typescript
const base = roundAmount(amount);
const gst = gstEnabled ? calculatePercentage(base, gstRate) : 0;
const tds = tdsEnabled ? calculatePercentage(base, tdsRate) : 0;
const net = roundAmount(base + gst - tds);

const invoice = {
  baseAmount: base,
  gstAmount: gst,
  tdsAmount: tds,
  netPayable: net
};
```

### Monthly Audit
```typescript
const report = await fetch('/api/calculations/reconciliation?month=01&year=2025');
const data = await report.json();

if (data.report.systemVariance > 0.01) {
  alert('System variance detected! Review required.');
}
```

---

**Last Updated:** 2025-01-15
**Version:** 1.3.0-enhanced
**Status:** ✅ Production Ready
