// Phase 0.3: how much traffic work fits in one 10 ms CPU slice.
//
// Runs in Node, not workerd: inside workerd, timers do not advance during synchronous CPU work
// (a Spectre mitigation), so CPU cannot be measured from inside a Worker. Node runs the same
// V8 engine, but on this machine's CPU, not Cloudflare's. The numbers are therefore an
// estimate of the production figure, and the chunk size is set with a wide safety margin.
//
// Run with: npm run bench

import { describe, expect, it } from "vitest";
import { aggregateChunk } from "../../src/core/aggregator";
import { decodeTraffic, encodeTraffic } from "../../src/core/codec";
import { findScenario } from "../../src/core/scenarios";
import { compileRule, replayChunk } from "../../src/core/rules/evaluate";
import { generateRange } from "../../src/core/simulator";
import type { RuleAST } from "../../src/core/types";

const def = findScenario("cs-trap-carrier");
if (!def) throw new Error("scenario missing");
const scenarioDef = def;

/** Median of `runs` timings, after `warm` untimed runs so the JIT has settled. */
function median(fn: () => void, runs = 41, warm = 20): number {
  for (let i = 0; i < warm; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? Number.NaN;
}

/** p95 of cold runs: a fresh isolate does not get a warm JIT, so this is the honest bound. */
function coldFirst(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const trivial: RuleAST = { kind: "compare", field: "ip.src.asnum", op: "eq", value: 64500 };

// About ten nodes, touching every column kind.
const tenNodes: RuleAST = {
  kind: "and",
  left: { kind: "compare", field: "http.request.uri.path", op: "eq", value: "/login" },
  right: {
    kind: "or",
    left: {
      kind: "and",
      left: { kind: "contains", field: "http.user_agent", value: "okhttp", lower: true },
      right: { kind: "not", operand: { kind: "in", field: "ip.src.country", values: ["GB", "FR"] } },
    },
    right: {
      kind: "or",
      left: { kind: "contains", field: "http.user_agent", value: "HeadlessChrome" },
      right: { kind: "in", field: "ip.src.asnum", values: [64520, 64521, 64522] },
    },
  },
};

describe("Phase 0.3 CPU per chunk (Node, this machine)", () => {
  it("measures generate, encode, decode, aggregate and evaluate", () => {
    const rows: string[] = [];
    rows.push("| chunk | generate | encode | decode | aggregate | eval trivial | eval ~10 nodes |");
    rows.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    const cold = coldFirst(() => generateRange(scenarioDef, 1, 0, 1000));
    for (const size of [250, 500, 1000, 2000, 4000]) {
      const chunk = generateRange(scenarioDef, 1, 0, size);
      const encoded = encodeTraffic(chunk);
      const dict = chunk.dictionary;
      const r1 = compileRule(trivial, dict);
      const r2 = compileRule(tenNodes, dict);
      if (!r1.ok || !r2.ok) throw new Error("bench rules must compile");
      const dur = scenarioDef.scenario.durationMs;
      const t = {
        generate: median(() => generateRange(scenarioDef, 1, 0, size)),
        encode: median(() => encodeTraffic(chunk)),
        decode: median(() => decodeTraffic(encoded, "x", dict)),
        aggregate: median(() => aggregateChunk(chunk, dur)),
        evalTrivial: median(() => replayChunk(r1.rule, chunk, dur)),
        evalTen: median(() => replayChunk(r2.rule, chunk, dur)),
      };
      const f = (x: number) => `${x.toFixed(3)} ms`;
      rows.push(
        `| ${size} | ${f(t.generate)} | ${f(t.encode)} | ${f(t.decode)} | ${f(t.aggregate)} | ${f(t.evalTrivial)} | ${f(t.evalTen)} |`,
      );
      expect(t.generate).toBeGreaterThan(0);
    }
    rows.push("");
    rows.push(`Cold first call, generate 1000 (includes JIT warm-up): ${cold.toFixed(3)} ms`);
    console.log(`\n${rows.join("\n")}\n`);
  });
});
