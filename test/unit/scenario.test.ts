// The experiment the project exists to run: on the trap scenario, is the naive rule worse than
// a precise one? These are measured on the deterministic simulator, so they are exact for the
// committed scenario and seed, and they are what docs/spikes.md cites.

import { describe, expect, it } from "vitest";
import { aggregateChunk, finalizeSummary } from "../../src/core/aggregator";
import { naiveBaseline } from "../../src/core/baseline";
import { toReplayResult } from "../../src/core/replay";
import { compileRule, replayChunk } from "../../src/core/rules/evaluate";
import { generateAll } from "../../src/core/simulator";
import type { RuleAST } from "../../src/core/types";
import { CANNED_RULE } from "../../src/model/fake";
import { trapScenario } from "./helpers";

const def = trapScenario();
const traffic = generateAll(def, def.scenario.seed);
const summary = finalizeSummary(aggregateChunk(traffic, def.scenario.durationMs), traffic.dictionary);

function replay(ast: RuleAST) {
  const c = compileRule(ast, traffic.dictionary);
  if (!c.ok) throw new Error(JSON.stringify(c.diagnostics));
  return toReplayResult(replayChunk(c.rule, traffic, def.scenario.durationMs).counts, def.scenario.thresholds, "ev");
}

describe("credential stuffing trap scenario", () => {
  it("the naive baseline blocks the shared carrier ASN", () => {
    expect(naiveBaseline(summary)?.ast).toEqual({ kind: "compare", field: "ip.src.asnum", op: "eq", value: 64500 });
  });

  it("the naive baseline fails the scenario on collateral damage", () => {
    const b = naiveBaseline(summary);
    if (!b) throw new Error("no baseline");
    const r = replay(b.ast);
    expect(r.passesThresholds).toBe(false);
    expect(r.legitimateBlockedRate).toBeGreaterThan(0.3);
  });

  it("a precise rule clears the thresholds and blocks far less legitimate traffic", () => {
    const b = naiveBaseline(summary);
    if (!b) throw new Error("no baseline");
    const precise = replay(CANNED_RULE);
    expect(precise.passesThresholds).toBe(true);
    expect(precise.legitimateBlocked).toBeLessThan(replay(b.ast).legitimateBlocked);
  });

  it("the exact counts for the committed seed, pinned so a simulator change is noticed", () => {
    const b = naiveBaseline(summary);
    if (!b) throw new Error("no baseline");
    const naive = replay(b.ast);
    const precise = replay(CANNED_RULE);
    expect({
      naive: [naive.attackBlocked, naive.attackTotal, naive.legitimateBlocked, naive.legitimateTotal],
      precise: [precise.attackBlocked, precise.attackTotal, precise.legitimateBlocked, precise.legitimateTotal],
    }).toMatchInlineSnapshot(`
      {
        "naive": [
          1061,
          1704,
          1987,
          4296,
        ],
        "precise": [
          1704,
          1704,
          0,
          4296,
        ],
      }
    `);
  });
});
