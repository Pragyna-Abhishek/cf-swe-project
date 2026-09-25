import { describe, expect, it } from "vitest";
import {
  aggregateChunk,
  BREAKDOWN_ROW_CAP,
  finalizeSummary,
  mergePartials,
  TIME_BUCKETS,
} from "../../src/core/aggregator";
import { planChunks } from "../../src/core/chunks";
import { generateAll, generateRange } from "../../src/core/simulator";
import { smallScenario } from "./helpers";

describe("aggregator", () => {
  const def = smallScenario(3000);
  const dur = def.scenario.durationMs;
  const whole = generateAll(def, 9);
  const summary = finalizeSummary(aggregateChunk(whole, dur), whole.dictionary);

  it("every breakdown accounts for every request", () => {
    for (const b of summary.breakdowns) {
      const sum = b.rows.reduce((a, r) => a + r.count, 0) + b.otherCount;
      expect(sum, b.dimension).toBe(summary.totalRequests);
    }
    expect(summary.totalRequests).toBe(3000);
  });

  it("the symptom slice accounts for every 401 and nothing else", () => {
    const status = summary.breakdowns.find((b) => b.dimension === "status");
    const n401 = status?.rows.find((r) => r.key === "401")?.count ?? 0;
    expect(summary.symptomSlice.totalRequests).toBe(n401);
    for (const b of summary.symptomSlice.breakdowns) {
      const sum = b.rows.reduce((a, r) => a + r.count, 0) + b.otherCount;
      expect(sum).toBe(n401);
    }
  });

  it("rows are sorted, capped, and carry stable evidence IDs", () => {
    for (const b of summary.breakdowns) {
      if (b.dimension === "timeBucket") {
        expect(b.rows).toHaveLength(TIME_BUCKETS);
        continue;
      }
      expect(b.rows.length).toBeLessThanOrEqual(BREAKDOWN_ROW_CAP);
      for (let i = 1; i < b.rows.length; i++) {
        expect((b.rows[i - 1]?.count ?? 0) >= (b.rows[i]?.count ?? 0)).toBe(true);
      }
    }
    expect(summary.breakdowns.map((b) => b.evidenceId)).toEqual(["ev_1", "ev_2", "ev_3", "ev_4", "ev_5", "ev_6", "ev_7"]);
    expect(summary.symptomSlice.breakdowns[0]?.evidenceId).toBe("ev_8");
  });

  it("merging chunk partials gives the same summary as one pass", () => {
    const partials = planChunks(3000, 700).map((c) => aggregateChunk(generateRange(def, 9, c.start, c.count), dur));
    const first = partials[0];
    if (!first) throw new Error("no partials");
    const merged = partials.slice(1).reduce(mergePartials, first);
    expect(finalizeSummary(merged, whole.dictionary)).toEqual(summary);
  });

  it("refuses to merge partials from different scenarios", () => {
    const a = aggregateChunk(generateRange(def, 1, 0, 10), dur);
    const b = aggregateChunk(generateRange(def, 2, 0, 10), dur);
    expect(() => mergePartials(a, b)).toThrow();
  });

  it("is label blind: flipping every label changes nothing the model can see", () => {
    const flipped = { ...whole, label: whole.label.map((l) => 1 - l) };
    expect(finalizeSummary(aggregateChunk(flipped, dur), whole.dictionary)).toEqual(summary);
    expect(JSON.stringify(summary)).not.toMatch(/attack|legitimate/i);
  });

  it("signals are shares of the whole", () => {
    expect(summary.signals.status401Share).toBeGreaterThan(0);
    expect(summary.signals.status401Share).toBeLessThanOrEqual(summary.signals.errorRate);
    expect(summary.signals.errorRate).toBeLessThanOrEqual(1);
  });

  it("the panel has one row per time bucket and sums to the total", () => {
    const p = aggregateChunk(whole, dur);
    expect(p.panel).toHaveLength(TIME_BUCKETS);
    expect(p.panel.flat().reduce((a, b) => a + b, 0)).toBe(3000);
  });
});
