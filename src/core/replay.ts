// Derived numbers. Every number the operator sees comes from the four replay counts through
// this file. CLAUDE.md invariant 5.

import type { ReplayCounts, ReplayResult, Scenario } from "./types";

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

/** safetyScore = attackBlockedRate * (1 - legitimateBlockedRate). DESIGN.md section 9. */
export function safetyScore(attackBlockedRate: number, legitimateBlockedRate: number): number {
  return attackBlockedRate * (1 - legitimateBlockedRate);
}

export function toReplayResult(
  counts: ReplayCounts,
  thresholds: Scenario["thresholds"],
  evidenceId: string,
): ReplayResult {
  if (
    counts.attackBlocked > counts.attackTotal ||
    counts.legitimateBlocked > counts.legitimateTotal ||
    Object.values(counts).some((v) => !Number.isInteger(v) || v < 0)
  ) {
    throw new Error(`inconsistent replay counts ${JSON.stringify(counts)}`);
  }
  const attackBlockedRate = rate(counts.attackBlocked, counts.attackTotal);
  const legitimateBlockedRate = rate(counts.legitimateBlocked, counts.legitimateTotal);
  return {
    ...counts,
    attackBlockedRate,
    legitimateBlockedRate,
    safetyScore: safetyScore(attackBlockedRate, legitimateBlockedRate),
    passesThresholds:
      attackBlockedRate >= thresholds.minAttackBlockedRate &&
      legitimateBlockedRate <= thresholds.maxLegitimateBlockedRate,
    evidenceId,
  };
}
