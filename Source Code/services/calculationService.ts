
import { BrokerageTransaction, PayoutBreakdown, SharingConfig, TeamMember, TransactionStatus, Client } from "../types";

/**
 * Validation result interface for breakdown calculations
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates a sharing configuration for correctness
 */
export const validateSharingConfig = (config: SharingConfig): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check company expense percentage
  if (config.companyExpensePct < 0 || config.companyExpensePct > 100) {
    errors.push(`Company expense must be between 0-100%, got ${config.companyExpensePct}%`);
  }

  // Check individual level percentages
  Object.entries(config.levels).forEach(([level, pct]) => {
    if (pct < 0 || pct > 100) {
      errors.push(`Level ${level} percentage must be 0-100%, got ${pct}%`);
    }
  });

  // Check total distribution doesn't exceed 100%
  const totalPct = Object.values(config.levels).reduce((sum, val) => sum + val, 0);
  if (totalPct > 100) {
    errors.push(`Total level sharing ${totalPct.toFixed(2)}% exceeds 100%`);
  } else if (totalPct < 50) {
    warnings.push(`Total level sharing ${totalPct.toFixed(2)}% is unusually low. Verify configuration.`);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
};

/**
 * Validates a calculated payout breakdown for accuracy
 */
export const validateBreakdown = (breakdown: PayoutBreakdown, tolerance: number = 0.01): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate expense calculation
  const expectedNetPool = breakdown.gross - breakdown.expenseAmount;
  const netPoolDiff = Math.abs(breakdown.netPool - expectedNetPool);
  if (netPoolDiff > tolerance) {
    errors.push(`Net pool mismatch: expected ${expectedNetPool.toFixed(2)}, got ${breakdown.netPool.toFixed(2)}`);
  }

  // Validate level payouts sum equals net pool
  const totalDistributed = Object.values(breakdown.levelPayouts).reduce((sum, val) => sum + val, 0);
  const distributionDiff = Math.abs(totalDistributed - breakdown.netPool);

  if (distributionDiff > tolerance) {
    errors.push(
      `Distribution mismatch: sum of level payouts (${totalDistributed.toFixed(2)}) ` +
      `does not match net pool (${breakdown.netPool.toFixed(2)}). Difference: ${distributionDiff.toFixed(4)}`
    );
  } else if (distributionDiff > 0.001) {
    warnings.push(`Minor rounding difference detected: ${distributionDiff.toFixed(4)} (within tolerance)`);
  }

  // Check for negative payouts
  Object.entries(breakdown.levelPayouts).forEach(([level, amount]) => {
    if (amount < 0) {
      errors.push(`Level ${level} has negative payout: ${amount}`);
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
};

/**
 * Validates custom level overrides for a team member
 */
export const validateCustomLevels = (member: TeamMember, config: SharingConfig): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!member.customLevels) {
    return { isValid: true, errors: [], warnings: [] };
  }

  // Check if custom rates are reasonable
  Object.entries(member.customLevels).forEach(([level, rate]) => {
    if (rate !== undefined) {
      if (rate < 0 || rate > 100) {
        errors.push(`${member.name}: Level ${level} custom rate ${rate}% is out of bounds (0-100%)`);
      }

      const defaultRate = config.levels[Number(level) as keyof typeof config.levels];
      if (rate > defaultRate * 3) {
        warnings.push(
          `${member.name}: Level ${level} custom rate ${rate}% is significantly higher than default ${defaultRate}%`
        );
      }
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
};

/**
 * Calculates the payout distribution based on a cumulative sharing model.
 * Each level has a cumulative "sharing rate".
 * A user at a specific level receives: (Their Cumulative Rate) - (Cumulative Rate of nearest assigned subordinate).
 * If no subordinate is assigned, they receive their full slice based on the incremental gaps.
 *
 * Example:
 * Gross 100 -> 15% Expense -> 85 Net Pool.
 * L6 Rate: 5% -> Pays 5% of 85.
 * L5 Rate: 20% -> Pays (20-5) = 15% of 85.
 * ...and so on.
 *
 * @enhanced Now includes rounding sweep to eliminate rounding errors
 */
/**
 * Owner-driven payout model (slices = % of GROSS):
 * 1. The PRIMARY OWNER of a client = the user assigned at the lowest filled
 *    level in the client's hierarchy (the direct Sherpa for most clients).
 * 2. The OWNER'S `customLevels` define how the client's GROSS brokerage is
 *    distributed across the L1..L7 chain. If the owner has no override, the
 *    `globalConfig.levels` slices are used as the default.
 * 3. Each assigned level receives `slice% × gross`. Anything NOT allocated to
 *    a level (either because the slice is 0 or because no user is assigned
 *    there) becomes **company retention** — implicit, no separate knob needed.
 *
 * Worked example matching the natural mental model:
 *   Owner override: L3=70, L4=15  →  sum 85% of gross
 *   Gross ₹100k → Ravisankar (L3) ₹70k · Kumaresh (L4) ₹15k · Company ₹15k
 *
 * (config.companyExpensePct is preserved for legacy fallback when neither the
 * owner nor the global config provides any level slices.)
 */
/**
 * CUMULATIVE designation model (lead-source aware).
 *  • Each level has a CUMULATIVE rate (config.designationCumulative), e.g.
 *    L1 25, L2 50, L3 75, L4 85, L5 90, L6 95.
 *  • The LEAD SOURCE seeds the base (config.leadSourcePct, e.g. 25%) — credited
 *    to whoever sourced the lead (defaults to the lowest assigned level = self-sourced).
 *  • Then walking the assigned levels low→high, each person earns
 *    cumulative[their level] − running baseline (the cumulative of the person below).
 *  • Company retention = 100% − the highest cumulative reached.
 */
const cumulativePayout = (
  gross: number,
  config: SharingConfig,
  hierarchy: Record<string, string>,
  leadSourceLevel: number | undefined
): PayoutBreakdown => {
  if (!Number.isFinite(gross)) gross = 0;
  const cum: Record<number, number> = (config as any).designationCumulative || {};
  const leadPct = Number((config as any).leadSourcePct) || 0;
  const levelPayouts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const userPayouts: Record<string, number> = {};

  const assigned: number[] = [];
  for (let l = 1; l <= 7; l++) {
    const uid = hierarchy[`level${l}Id` as keyof typeof hierarchy];
    if (uid && String(uid).trim()) assigned.push(l);
  }
  if (assigned.length === 0) {
    return { gross, expenseAmount: gross, netPool: 0,
      levelPayouts: levelPayouts as any, userPayouts };
  }

  // Lead source = tagged level, else lowest assigned (self-sourced).
  const lsl = (leadSourceLevel && hierarchy[`level${leadSourceLevel}Id` as keyof typeof hierarchy])
    ? leadSourceLevel : assigned[0];
  const lsUid = hierarchy[`level${lsl}Id` as keyof typeof hierarchy];

  let baseline = 0;
  if (lsUid && leadPct > 0) {
    const pay = Math.round((gross * leadPct / 100) * 100) / 100;
    userPayouts[lsUid] = (userPayouts[lsUid] || 0) + pay;
    levelPayouts[lsl] = (levelPayouts[lsl] || 0) + pay;
    baseline = leadPct;
  }
  for (const l of assigned) {
    const c = Number(cum[l]) || 0;
    if (c > baseline) {
      const slice = c - baseline;
      const uid = hierarchy[`level${l}Id` as keyof typeof hierarchy];
      const pay = Math.round((gross * slice / 100) * 100) / 100;
      if (uid) userPayouts[uid] = (userPayouts[uid] || 0) + pay;
      levelPayouts[l] = (levelPayouts[l] || 0) + pay;
      baseline = c;
    }
  }
  const distributed = Object.values(userPayouts).reduce((s, v) => s + v, 0);
  const expenseAmount = Math.round((gross - distributed) * 100) / 100;
  const netPool = Math.round((gross - expenseAmount) * 100) / 100;
  return { gross, expenseAmount, netPool, levelPayouts: levelPayouts as any, userPayouts };
};

export const calculatePayout = (
  gross: number,
  config: SharingConfig,
  hierarchy: Record<string, string> = {}, // level -> userId mapping
  team: TeamMember[] | Map<string, TeamMember> = [],
  leadSourceLevel?: number,             // which level (1..7) sourced this client's lead
  period?: string                       // 'YYYY-MM' brokerage period — resolves effective-dated rates
): PayoutBreakdown => {
  // Cumulative designation model takes precedence when enabled AND rates exist
  // (guard prevents an empty/corrupt config from silently paying everyone ₹0).
  const dc = (config as any).designationCumulative;

  const levelsOrdered = [1, 2, 3, 4, 5, 6, 7] as const;
  const levelPayouts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };

  // 1. Find the primary client owner = lowest-level user assigned in the hierarchy.
  const teamRaw = (id: string): TeamMember | undefined =>
    Array.isArray(team) ? team.find(t => t.id === id) : team.get(id);

  // Effective-dated rates — MUST stay identical to server.js / recalcRun.js
  // memberAsOf(). A member's level and sharing rate form a timeline; a promotion
  // applies from its effective month FORWARD and must never restate earlier
  // (frequently already-invoiced) months. No rateHistory => current values, so
  // members who have never been re-graded behave exactly as before.
  const teamGet = (id: string): TeamMember | undefined => {
    const info = teamRaw(id);
    const hist = (info as any)?.rateHistory;
    if (!info || !Array.isArray(hist) || hist.length === 0 || !period) return info;
    const p = String(period);
    let inForce: any = null, earliest: any = null;
    for (const h of hist) {
      if (!h || !h.effectiveFrom) continue;
      const ef = String(h.effectiveFrom);
      if (!earliest || ef < String(earliest.effectiveFrom)) earliest = h;
      if (ef <= p && (!inForce || ef > String(inForce.effectiveFrom))) inForce = h;
    }
    const pick = inForce || earliest;
    if (!pick) return info;
    return {
      ...info,
      level: (pick.level !== undefined && pick.level !== null) ? Number(pick.level) : info.level,
      customLevels: pick.customLevels || info.customLevels,
    } as TeamMember;
  };

  // RESIDUAL model — company keeps companyExpensePct off the top; levels below the
  // residual level keep their per-RM slice; the residual-level user absorbs the
  // rest. Mirrors server.js/recalcRun calcResidual so import-time matches recalc.
  // RESIDUAL is the ONLY payout model (Slices/Cumulative removed 2026-08-18 —
  // they allowed the levels to sum past 100%, paying out more than was received).
  {
    const rl = Number((config as any).residualLevel) || 4;
    const companyPct = Number(config.companyExpensePct) || 0;
    const up: Record<string, number> = {};
    let oCL: TeamMember['customLevels'] | undefined;
    for (const l of levelsOrdered) { const u = hierarchy[`level${l}Id` as keyof typeof hierarchy]; if (u && u.trim()) { oCL = teamGet(u)?.customLevels; break; } }
    const paid = new Set<string>(); let lowerSum = 0, dist = 0;
    for (let l = 1; l < rl; l++) {
      const u = hierarchy[`level${l}Id` as keyof typeof hierarchy]; if (!u || !u.trim() || paid.has(u)) continue; paid.add(u);
      const info = teamGet(u); const cl = info?.customLevels as Record<number, number> | undefined; const uL = info?.level;
      const clAny = cl as any;
      const pct = Math.max(0, (clAny && uL !== undefined && clAny[uL] !== undefined) ? clAny[uL] : (clAny && clAny[l] !== undefined) ? clAny[l] : ((oCL as any)?.[l] !== undefined ? (oCL as any)[l] : ((config.levels as any)[l] || 0)));
      // `p !== 0`, NOT `p > 0` — guarding on the AMOUNT dropped the RM's slice on
      // negative-gross (clawback) rows. 4dp to match server.js/recalcRun exactly;
      // 2dp here made import-time figures disagree with the ledger by design.
      const p = Math.round(gross * pct / 100 * 10000) / 10000; levelPayouts[l] = p; if (p !== 0) up[u] = (up[u] || 0) + p; lowerSum += pct; dist += p;
    }
    // Lead-source add-on belongs to the LOWER levels, so it also reduces the
    // residual — identical to server.js / recalcRun.js calcResidual.
    const leadPct = Number((config as any).leadSourcePct) || 0;
    if (leadPct > 0 && leadSourceLevel && leadSourceLevel < rl) {
      const su = hierarchy[`level${leadSourceLevel}Id` as keyof typeof hierarchy];
      if (su && su.trim()) { const p = Math.round(gross * leadPct / 100 * 10000) / 10000; levelPayouts[leadSourceLevel] = (levelPayouts[leadSourceLevel] || 0) + p; if (p !== 0) up[su] = (up[su] || 0) + p; lowerSum += leadPct; dist += p; }
    }
    let ru: string | undefined, ruL = rl;
    for (let l = rl; l <= 7; l++) { const u = hierarchy[`level${l}Id` as keyof typeof hierarchy]; if (u && u.trim()) { ru = u; ruL = l; break; } }
    if (ru && !paid.has(ru)) { const surplus = Math.max(0, 100 - companyPct - lowerSum); const p = Math.round(gross * surplus / 100 * 10000) / 10000; levelPayouts[ruL] = (levelPayouts[ruL] || 0) + p; if (p !== 0) up[ru] = (up[ru] || 0) + p; dist += p; }
    const exp = Math.round((gross - dist) * 100) / 100;
    return { gross, expenseAmount: exp, netPool: Math.round((gross - exp) * 100) / 100, levelPayouts: levelPayouts as any, userPayouts: up };
  }

};

export const calculateUserShare = (
  tx: BrokerageTransaction,
  member: TeamMember,
  globalConfig: SharingConfig
): number => {
  if (tx.breakdown) {
    if (tx.breakdown.userPayouts && tx.breakdown.userPayouts[member.id] !== undefined) {
      return tx.breakdown.userPayouts[member.id];
    }
    return tx.breakdown.levelPayouts[member.level as keyof typeof tx.breakdown.levelPayouts] || 0;
  }

  // Fallback for uncalculated transactions (deprecated)
  const basePool = Math.round((tx.grossAmount - (tx.grossAmount * (globalConfig.companyExpensePct / 100))) * 100) / 100;
  const pct = (member.customLevels?.[member.level as keyof typeof member.customLevels] ?? globalConfig.levels[member.level as keyof typeof globalConfig.levels]) || 0;
  return Math.round((basePool * (pct / 100)) * 100) / 100;
};

export const runBatchCalculation = (
  transactions: BrokerageTransaction[],
  config: SharingConfig,
  clients: Client[],
  team: TeamMember[]
): BrokerageTransaction[] => {
  const clientMap = new Map();
  clients.forEach(c => clientMap.set(c.id, c));
  const teamMap = new Map();
  team.forEach(t => teamMap.set(t.id, t));

  return transactions.map(tx => {
    if (!tx.mappedClientId) return tx;

    const client = clientMap.get(tx.mappedClientId);
    if (!client) return tx;

    const breakdown = calculatePayout(
      tx.grossAmount,
      config,
      client.hierarchy,
      teamMap,
      client.leadSourceLevel,
      tx.brokeragePeriod || (tx.transactionDate || '').substring(0, 7)
    );

    // Validate the calculated breakdown
    const validation = validateBreakdown(breakdown);
    if (!validation.isValid) {
      console.warn(`Breakdown validation failed for transaction ${tx.id}:`, validation.errors);
    }

    return {
      ...tx,
      breakdown,
      status: TransactionStatus.VALIDATED
    };
  });
};

/**
 * Recalculates and verifies a single transaction's breakdown
 * Useful for debugging or reconciliation
 */
export const verifyTransaction = (
  tx: BrokerageTransaction,
  config: SharingConfig,
  clients: Client[],
  team: TeamMember[]
): {
  transaction: BrokerageTransaction;
  storedBreakdown: PayoutBreakdown | undefined;
  recalculatedBreakdown: PayoutBreakdown;
  validation: ValidationResult;
  matches: boolean;
} => {
  const clientMap = new Map(clients.map(c => [c.id, c]));
  const teamMap = new Map(team.map(t => [t.id, t]));

  const client = tx.mappedClientId ? clientMap.get(tx.mappedClientId) : null;

  if (!client) {
    return {
      transaction: tx,
      storedBreakdown: tx.breakdown,
      recalculatedBreakdown: { gross: 0, expenseAmount: 0, netPool: 0, levelPayouts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }, userPayouts: {} },
      validation: { isValid: false, errors: ['Client not found'], warnings: [] },
      matches: false
    };
  }

  const recalculatedBreakdown = calculatePayout(
    tx.grossAmount,
    config,
    client.hierarchy,
    teamMap
  );

  const validation = validateBreakdown(recalculatedBreakdown);

  // Check if stored breakdown matches recalculated
  let matches = true;
  if (tx.breakdown) {
    const tolerance = 0.01;
    const levels: Array<1|2|3|4|5|6|7> = [1, 2, 3, 4, 5, 6, 7];
    matches = Math.abs(tx.breakdown.netPool - recalculatedBreakdown.netPool) <= tolerance &&
      levels.every(level => {
        const stored = tx.breakdown!.levelPayouts[level] || 0;
        const recalc = recalculatedBreakdown.levelPayouts[level] || 0;
        return Math.abs(stored - recalc) <= tolerance;
      }) &&
      Object.keys(recalculatedBreakdown.userPayouts || {}).every(uid => {
        const stored = tx.breakdown!.userPayouts?.[uid] || 0;
        const recalc = recalculatedBreakdown.userPayouts?.[uid] || 0;
        return Math.abs(stored - recalc) <= tolerance;
      });
  } else {
    matches = false;
  }

  return {
    transaction: tx,
    storedBreakdown: tx.breakdown,
    recalculatedBreakdown,
    validation,
    matches
  };
};

/**
 * Generates a reconciliation report for a batch of transactions
 */
export interface ReconciliationReport {
  totalTransactions: number;
  validTransactions: number;
  invalidTransactions: number;
  mismatchedTransactions: number;
  totalGross: number;
  totalNetPool: number;
  totalDistributed: number;
  variance: number;
  errors: Array<{ transactionId: string; errors: string[] }>;
  warnings: Array<{ transactionId: string; warnings: string[] }>;
}

export const generateReconciliationReport = (
  transactions: BrokerageTransaction[],
  config: SharingConfig,
  clients: Client[],
  team: TeamMember[]
): ReconciliationReport => {
  let validTransactions = 0;
  let invalidTransactions = 0;
  let mismatchedTransactions = 0;
  let totalGross = 0;
  let totalNetPool = 0;
  let totalDistributed = 0;

  const errors: Array<{ transactionId: string; errors: string[] }> = [];
  const warnings: Array<{ transactionId: string; warnings: string[] }> = [];

  transactions.forEach(tx => {
    if (!tx.breakdown) {
      warnings.push({ transactionId: tx.id, warnings: ['No breakdown available'] });
      return;
    }

    totalGross += tx.grossAmount;
    totalNetPool += tx.breakdown.netPool;
    const txDistributed = Object.values(tx.breakdown.levelPayouts).reduce((sum, val) => sum + val, 0);
    totalDistributed += txDistributed;

    const validation = validateBreakdown(tx.breakdown);

    if (validation.isValid) {
      validTransactions++;
    } else {
      invalidTransactions++;
      errors.push({ transactionId: tx.id, errors: validation.errors });
    }

    if (validation.warnings.length > 0) {
      warnings.push({ transactionId: tx.id, warnings: validation.warnings });
    }

    // Check if recalculation matches stored data
    const verification = verifyTransaction(tx, config, clients, team);
    if (!verification.matches) {
      mismatchedTransactions++;
      warnings.push({
        transactionId: tx.id,
        warnings: ['Stored breakdown does not match recalculated values']
      });
    }
  });

  const variance = Math.round((totalNetPool - totalDistributed) * 100) / 100;

  return {
    totalTransactions: transactions.length,
    validTransactions,
    invalidTransactions,
    mismatchedTransactions,
    totalGross,
    totalNetPool,
    totalDistributed,
    variance,
    errors,
    warnings
  };
};
