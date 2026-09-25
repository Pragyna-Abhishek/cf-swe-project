// Phase 4: every scenario in the registry runs end to end and its threshold outcome is recorded,
// not assumed. For a trap, the naive baseline is expected to fail on collateral damage (that is
// the property that makes it a trap); for a non-trap, the attack is meant to be easily separable
// by a single attribute, so the naive baseline is expected to pass. Both are asserted from the
// actual simulator output, never hardcoded.

import { describe, expect, it } from "vitest";
import { aggregateChunk, finalizeSummary } from "../../src/core/aggregator";
import { naiveBaseline } from "../../src/core/baseline";
import { toReplayResult } from "../../src/core/replay";
import { compileRule, replayChunk } from "../../src/core/rules/evaluate";
import { generateAll } from "../../src/core/simulator";
import { SCENARIOS } from "../../src/core/scenarios";
import type { TrapAttribute } from "../../src/core/types";

/** Which RuleAST field name corresponds to each trapAttribute, for cross-checking the baseline. */
const TRAP_FIELD: Record<TrapAttribute, string> = {
  asn: "ip.src.asnum",
  path: "http.request.uri.path",
  country: "ip.src.country",
  userAgent: "http.user_agent",
};

describe("every registered scenario", () => {
  const traps = SCENARIOS.filter((d) => d.scenario.isTrap);
  const nonTraps = SCENARIOS.filter((d) => !d.scenario.isTrap);

  it("has 8 to 12 scenarios across the three families, at least 3 traps with different trapAttribute values", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(8);
    expect(SCENARIOS.length).toBeLessThanOrEqual(12);
    const families = new Set(SCENARIOS.map((d) => d.scenario.family));
    expect(families).toEqual(new Set(["credential-stuffing", "scraper", "l7-flood"]));
    const trapAttributes = new Set(traps.map((d) => d.scenario.trapAttribute));
    expect(trapAttributes.size).toBeGreaterThanOrEqual(3);
    expect(traps.length).toBeGreaterThanOrEqual(3);
  });

  it("every scenario id is unique", () => {
    const ids = SCENARIOS.map((d) => d.scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const def of SCENARIOS) {
    it(`${def.scenario.id}: internally consistent traffic and replay counts`, () => {
      const traffic = generateAll(def, def.scenario.seed);
      const summary = finalizeSummary(aggregateChunk(traffic, def.scenario.durationMs, def.scenario.symptomStatus), traffic.dictionary);
      const baseline = naiveBaseline(summary);
      expect(baseline).not.toBeNull();
      if (!baseline) return;
      const compiled = compileRule(baseline.ast, traffic.dictionary);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      const result = toReplayResult(replayChunk(compiled.rule, traffic, def.scenario.durationMs).counts, def.scenario.thresholds, "ev");
      expect(result.attackBlocked).toBeLessThanOrEqual(result.attackTotal);
      expect(result.legitimateBlocked).toBeLessThanOrEqual(result.legitimateTotal);
      expect(result.attackTotal + result.legitimateTotal).toBe(def.scenario.requestCount);
    });
  }

  for (const def of traps) {
    it(`${def.scenario.id}: the trap works -- the naive baseline latches onto the shared ${def.scenario.trapAttribute} and fails on collateral damage`, () => {
      const traffic = generateAll(def, def.scenario.seed);
      const summary = finalizeSummary(aggregateChunk(traffic, def.scenario.durationMs, def.scenario.symptomStatus), traffic.dictionary);
      const baseline = naiveBaseline(summary);
      expect(baseline).not.toBeNull();
      if (!baseline || baseline.ast.kind !== "compare") throw new Error("expected a single compare rule");
      const trapAttribute = def.scenario.trapAttribute;
      if (!trapAttribute) throw new Error("trap scenario missing trapAttribute");
      expect(baseline.ast.field).toBe(TRAP_FIELD[trapAttribute]);
      const compiled = compileRule(baseline.ast, traffic.dictionary);
      if (!compiled.ok) throw new Error("baseline does not compile");
      const result = toReplayResult(replayChunk(compiled.rule, traffic, def.scenario.durationMs).counts, def.scenario.thresholds, "ev");
      expect(result.passesThresholds).toBe(false);
    });
  }

  for (const def of nonTraps) {
    it(`${def.scenario.id}: not a trap -- the naive baseline separates the attack cleanly and passes`, () => {
      const traffic = generateAll(def, def.scenario.seed);
      const summary = finalizeSummary(aggregateChunk(traffic, def.scenario.durationMs, def.scenario.symptomStatus), traffic.dictionary);
      const baseline = naiveBaseline(summary);
      expect(baseline).not.toBeNull();
      if (!baseline) return;
      const compiled = compileRule(baseline.ast, traffic.dictionary);
      if (!compiled.ok) throw new Error("baseline does not compile");
      const result = toReplayResult(replayChunk(compiled.rule, traffic, def.scenario.durationMs).counts, def.scenario.thresholds, "ev");
      expect(result.passesThresholds).toBe(true);
    });
  }
});
