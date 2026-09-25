import { describe, expect, it } from "vitest";
import { decodeRequests } from "../../../src/core/decode";
import { Rng } from "../../../src/core/random";
import { toReplayResult } from "../../../src/core/replay";
import { compileRule, matchMask, mergeChunkReplays, replayChunk } from "../../../src/core/rules/evaluate";
import { referenceMatches, referenceReplay } from "../../../src/core/rules/reference";
import { typecheck } from "../../../src/core/rules/typecheck";
import { hasErrors } from "../../../src/core/rules/diagnostics";
import { emptyTraffic, generateAll, generateRange } from "../../../src/core/simulator";
import type { ColumnarTraffic, Request, RuleAST, TrafficDictionary } from "../../../src/core/types";
import { smallScenario } from "../helpers";
import { typedAst } from "./gen";

// Hand-built traffic with known answers. Four requests, every column different.
const dictionary: TrafficDictionary = {
  methods: ["GET", "POST"],
  paths: ["/", "/login"],
  countries: ["US", "GB"],
  userAgents: ["Mozilla/5.0", "OkHttp/4.9.3", "okhttp/4.9.3"],
};

function handTraffic(): ColumnarTraffic {
  const t = emptyTraffic("hand", 1, 0, 4, dictionary);
  // index:        0        1         2         3
  t.method.set([0, 1, 1, 1]);
  t.path.set([0, 1, 1, 1]);
  t.country.set([0, 0, 1, 1]);
  t.userAgent.set([0, 1, 2, 0]);
  t.asn.set([64500, 64500, 64520, 64501]);
  t.status.set([200, 401, 401, 200]);
  t.label.set([0, 1, 1, 0]);
  t.offsetMs.set([0, 1000, 2000, 3000]);
  return t;
}

function blocked(ast: RuleAST): number[] {
  const c = compileRule(ast, dictionary);
  if (!c.ok) throw new Error(JSON.stringify(c.diagnostics));
  return [...matchMask(c.rule, handTraffic())];
}

describe("columnar evaluator, hand-checked", () => {
  it("compare eq and ne on string and number fields", () => {
    expect(blocked({ kind: "compare", field: "http.request.uri.path", op: "eq", value: "/login" })).toEqual([0, 1, 1, 1]);
    expect(blocked({ kind: "compare", field: "http.request.method", op: "ne", value: "GET" })).toEqual([0, 1, 1, 1]);
    expect(blocked({ kind: "compare", field: "ip.src.asnum", op: "eq", value: 64500 })).toEqual([1, 1, 0, 0]);
    expect(blocked({ kind: "compare", field: "http.response.code", op: "ne", value: 200 })).toEqual([0, 1, 1, 0]);
  });

  it("a literal absent from the dictionary matches nothing, and ne matches everything", () => {
    expect(blocked({ kind: "compare", field: "ip.src.country", op: "eq", value: "FR" })).toEqual([0, 0, 0, 0]);
    expect(blocked({ kind: "compare", field: "ip.src.country", op: "ne", value: "FR" })).toEqual([1, 1, 1, 1]);
  });

  it("contains, with and without lower()", () => {
    expect(blocked({ kind: "contains", field: "http.user_agent", value: "okhttp" })).toEqual([0, 0, 1, 0]);
    expect(blocked({ kind: "contains", field: "http.user_agent", value: "okhttp", lower: true })).toEqual([0, 1, 1, 0]);
  });

  it("in, over strings with lower() and over numbers", () => {
    expect(blocked({ kind: "in", field: "ip.src.country", values: ["GB", "FR"] })).toEqual([0, 0, 1, 1]);
    expect(blocked({ kind: "in", field: "ip.src.asnum", values: [64520, 64501] })).toEqual([0, 0, 1, 1]);
    expect(blocked({ kind: "in", field: "http.user_agent", values: ["okhttp/4.9.3"], lower: true })).toEqual([0, 1, 1, 0]);
  });

  it("lower() on eq and ne", () => {
    expect(blocked({ kind: "compare", field: "http.user_agent", op: "eq", value: "okhttp/4.9.3", lower: true })).toEqual([
      0, 1, 1, 0,
    ]);
    expect(blocked({ kind: "compare", field: "http.user_agent", op: "ne", value: "okhttp/4.9.3", lower: true })).toEqual([
      1, 0, 0, 1,
    ]);
  });

  it("and, or, not", () => {
    const login: RuleAST = { kind: "compare", field: "http.request.uri.path", op: "eq", value: "/login" };
    const us: RuleAST = { kind: "compare", field: "ip.src.country", op: "eq", value: "US" };
    expect(blocked({ kind: "and", left: login, right: us })).toEqual([0, 1, 0, 0]);
    expect(blocked({ kind: "or", left: login, right: us })).toEqual([1, 1, 1, 1]);
    expect(blocked({ kind: "not", operand: login })).toEqual([1, 0, 0, 0]);
  });

  it("replay produces the four counts and a blocked panel", () => {
    const c = compileRule({ kind: "compare", field: "http.response.code", op: "eq", value: 401 }, dictionary);
    if (!c.ok) throw new Error("compile");
    const r = replayChunk(c.rule, handTraffic(), 4000);
    expect(r.counts).toEqual({ attackTotal: 2, attackBlocked: 2, legitimateTotal: 2, legitimateBlocked: 0 });
    expect(r.blockedPanel.flat().reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("refuses to compile rules that fail the type checker or the limits", () => {
    expect(compileRule({ kind: "compare", field: "ip.src.asnum", op: "eq", value: "x" }, dictionary).ok).toBe(false);
    const values = Array.from({ length: 33 }, (_, i) => i);
    expect(compileRule({ kind: "in", field: "ip.src.asnum", values }, dictionary).ok).toBe(false);
  });

  it("refuses traffic with a different dictionary", () => {
    const c = compileRule({ kind: "compare", field: "ip.src.asnum", op: "eq", value: 1 }, dictionary);
    if (!c.ok) throw new Error("compile");
    const other = emptyTraffic("x", 1, 0, 1, { ...dictionary, paths: ["/"] });
    expect(() => matchMask(c.rule, other)).toThrow();
  });
});

describe("replay numbers", () => {
  it("rates and the safety score are derived from the counts", () => {
    const r = toReplayResult(
      { attackTotal: 100, attackBlocked: 90, legitimateTotal: 200, legitimateBlocked: 10 },
      { minAttackBlockedRate: 0.9, maxLegitimateBlockedRate: 0.03 },
      "ev_x",
    );
    expect(r.attackBlockedRate).toBe(0.9);
    expect(r.legitimateBlockedRate).toBe(0.05);
    expect(r.safetyScore).toBeCloseTo(0.855);
    expect(r.passesThresholds).toBe(false);
  });

  it("blocking everything or nothing scores zero", () => {
    const th = { minAttackBlockedRate: 0.9, maxLegitimateBlockedRate: 0.03 };
    expect(toReplayResult({ attackTotal: 5, attackBlocked: 5, legitimateTotal: 5, legitimateBlocked: 5 }, th, "e").safetyScore).toBe(0);
    expect(toReplayResult({ attackTotal: 5, attackBlocked: 0, legitimateTotal: 5, legitimateBlocked: 0 }, th, "e").safetyScore).toBe(0);
  });

  it("refuses inconsistent counts: blocked never exceeds total", () => {
    const th = { minAttackBlockedRate: 0, maxLegitimateBlockedRate: 1 };
    expect(() => toReplayResult({ attackTotal: 1, attackBlocked: 2, legitimateTotal: 0, legitimateBlocked: 0 }, th, "e")).toThrow();
  });
});

describe("property: columnar evaluator agrees with the naive reference evaluator", () => {
  it("on generated rules over generated traffic, request by request", () => {
    const def = smallScenario(1500);
    let rules = 0;
    let nonTrivial = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const traffic = generateAll(def, seed);
      const requests: Request[] = decodeRequests(traffic);
      const rng = new Rng(seed * 7919);
      for (let k = 0; k < 40; k++) {
        const ast = typedAst(rng, traffic.dictionary);
        if (hasErrors(typecheck(ast))) continue;
        const compiled = compileRule(ast, traffic.dictionary);
        if (!compiled.ok) continue;
        const mask = matchMask(compiled.rule, traffic);
        for (let i = 0; i < requests.length; i++) {
          const r = requests[i];
          if (!r) continue;
          const expected = referenceMatches(ast, r) ? 1 : 0;
          if (mask[i] !== expected) {
            throw new Error(`seed ${seed} rule ${k}: disagree on request ${i}: ${JSON.stringify(ast)}`);
          }
        }
        const got = replayChunk(compiled.rule, traffic, def.scenario.durationMs).counts;
        expect(got).toEqual(referenceReplay(ast, requests));
        rules++;
        const hits = mask.reduce((a, b) => a + b, 0);
        if (hits > 0 && hits < requests.length) nonTrivial++;
      }
    }
    // Guard against a generator that only produces rules matching nothing or everything.
    expect(rules).toBeGreaterThan(800);
    expect(nonTrivial).toBeGreaterThan(rules / 3);
  });

  it("chunked replay equals whole replay", () => {
    const def = smallScenario(2500);
    const whole = generateAll(def, 3);
    const rng = new Rng(99);
    for (let k = 0; k < 30; k++) {
      const ast = typedAst(rng, whole.dictionary);
      const c = compileRule(ast, whole.dictionary);
      if (!c.ok) continue;
      const parts = [0, 1000, 2000].map((s) => replayChunk(c.rule, generateRange(def, 3, s, 1000), def.scenario.durationMs));
      const first = parts[0];
      if (!first) throw new Error("no parts");
      const merged = parts.slice(1).reduce(mergeChunkReplays, first);
      expect(merged).toEqual(replayChunk(c.rule, whole, def.scenario.durationMs));
    }
  });
});
