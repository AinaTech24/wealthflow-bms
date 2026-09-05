/**
 * Calculation Validation Utilities
 * Reusable validation functions for financial calculations
 */

import { SharingConfig, PayoutBreakdown } from '../types';

/**
 * Validates that a percentage is within acceptable bounds
 */
export const isValidPercentage = (value: number, allowZero: boolean = true): boolean => {
  if (!allowZero && value === 0) return false;
  return value >= 0 && value <= 100;
};

/**
 * Validates that an amount is valid (non-negative, finite)
 */
export const isValidAmount = (value: number): boolean => {
  return typeof value === 'number' && isFinite(value) && value >= 0;
};

/**
 * Safely rounds a monetary amount to 2 decimal places
 */
export const roundAmount = (value: number): number => {
  return Math.round(value * 100) / 100;
};

/**
 * Calculates percentage of an amount with proper rounding
 */
export const calculatePercentage = (amount: number, percentage: number): number => {
  return Math.round(amount * percentage) / 100;
};

/**
 * Validates sharing config before use
 */
export const validateConfig = (config: SharingConfig): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  if (!isValidPercentage(config.companyExpensePct)) {
    errors.push(`Invalid company expense percentage: ${config.companyExpensePct}`);
  }

  const totalLevelPct = Object.values(config.levels).reduce((sum, val) => sum + val, 0);
  if (totalLevelPct > 100) {
    errors.push(`Total level percentages exceed 100%: ${totalLevelPct.toFixed(2)}%`);
  }

  Object.entries(config.levels).forEach(([level, pct]) => {
    if (!isValidPercentage(pct)) {
      errors.push(`Invalid percentage for level ${level}: ${pct}`);
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
};

/**
 * Validates breakdown calculation accuracy
 */
export const validateBreakdownAccuracy = (
  breakdown: PayoutBreakdown,
  tolerance: number = 0.01
): { valid: boolean; variance: number; message: string } => {
  // Check expense calculation
  const expectedNetPool = roundAmount(breakdown.gross - breakdown.expenseAmount);
  const netPoolVariance = Math.abs(breakdown.netPool - expectedNetPool);

  if (netPoolVariance > tolerance) {
    return {
      valid: false,
      variance: netPoolVariance,
      message: `Net pool calculation error: expected ${expectedNetPool}, got ${breakdown.netPool}`
    };
  }

  // Check distribution sum
  const totalDistributed = Object.values(breakdown.levelPayouts).reduce((sum, val) => sum + val, 0);
  const distributionVariance = Math.abs(roundAmount(totalDistributed) - breakdown.netPool);

  if (distributionVariance > tolerance) {
    return {
      valid: false,
      variance: distributionVariance,
      message: `Distribution sum (${roundAmount(totalDistributed)}) does not match net pool (${breakdown.netPool})`
    };
  }

  return {
    valid: true,
    variance: distributionVariance,
    message: 'Breakdown is accurate'
  };
};

/**
 * Formats amount for display with proper currency formatting
 */
export const formatAmount = (amount: number, currency: string = '₹'): string => {
  return `${currency}${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/**
 * Compares two amounts with tolerance for equality
 */
export const amountsEqual = (amount1: number, amount2: number, tolerance: number = 0.01): boolean => {
  return Math.abs(amount1 - amount2) <= tolerance;
};

/**
 * Validates GST/TDS rates are reasonable
 */
export const validateTaxRates = (gstRate?: number, tdsRate?: number): string[] => {
  const errors: string[] = [];

  if (gstRate !== undefined) {
    if (!isValidPercentage(gstRate)) {
      errors.push(`Invalid GST rate: ${gstRate}%`);
    } else if (gstRate > 30) {
      errors.push(`GST rate ${gstRate}% seems unusually high (max typically 28%)`);
    }
  }

  if (tdsRate !== undefined) {
    if (!isValidPercentage(tdsRate)) {
      errors.push(`Invalid TDS rate: ${tdsRate}%`);
    } else if (tdsRate > 30) {
      errors.push(`TDS rate ${tdsRate}% seems unusually high`);
    }
  }

  return errors;
};

/**
 * Calculates net payable with GST addition and TDS deduction
 */
export const calculateNetPayable = (
  baseAmount: number,
  gstEnabled: boolean,
  gstRate: number,
  tdsEnabled: boolean,
  tdsRate: number
): {
  baseAmount: number;
  gstAmount: number;
  tdsAmount: number;
  netPayable: number;
} => {
  const base = roundAmount(baseAmount);
  const gst = gstEnabled ? calculatePercentage(base, gstRate) : 0;
  const tds = tdsEnabled ? calculatePercentage(base, tdsRate) : 0;
  const net = roundAmount(base + gst - tds);

  return {
    baseAmount: base,
    gstAmount: gst,
    tdsAmount: tds,
    netPayable: net
  };
};
