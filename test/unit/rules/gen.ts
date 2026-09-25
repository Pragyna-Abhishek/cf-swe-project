// Seeded generators for property tests. Built on the project's own Rng rather than a property
// testing library: one less dependency, and every failure prints the seed that reproduces it.

import { Rng } from "../../../src/core/random";
import { ALL_FIELDS, NUMBER_FIELDS, STRING_FIELDS } from "../../../src/core/rules/fields";
import type { RuleAST, RuleField, StringField, TrafficDictionary } from "../../../src/core/types";

const pick = <T>(rng: Rng, xs: readonly T[]): T => {
  const x = xs[rng.int(xs.length)];
  if (x === undefined) throw new Error("pick from empty list");
  return x;
};

// Strings that stress the printer and lexer: quotes, backslashes, spaces, keywords, non-ASCII.
const AWKWARD = ['a"b', "back\\slash", "\\\"", "and or not", "é漢字🙂", "", " ", "lower(x)", "{}", "()", "123"];

function randomString(rng: Rng): string {
  if (rng.next() < 0.3) return pick(rng, AWKWARD);
  const len = rng.int(12);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(0x20 + rng.int(0x5f));
  return s;
}

function randomNumber(rng: Rng): number {
  return rng.next() < 0.5 ? rng.int(1000) : rng.int(4294967296);
}

/**
 * Any AST the RuleAST type allows, including type-incorrect ones. The round trip must hold for
 * all of them: printing and parsing do not depend on types.
 */
export function anyAst(rng: Rng, depth = 0): RuleAST {
  const leaf = depth >= 5 || rng.next() < 0.35;
  if (!leaf) {
    const k = rng.int(3);
    if (k === 0) return { kind: "and", left: anyAst(rng, depth + 1), right: anyAst(rng, depth + 1) };
    if (k === 1) return { kind: "or", left: anyAst(rng, depth + 1), right: anyAst(rng, depth + 1) };
    return { kind: "not", operand: anyAst(rng, depth + 1) };
  }
  const lower = rng.next() < 0.3 ? { lower: true as const } : {};
  const value = () => (rng.next() < 0.5 ? randomString(rng) : randomNumber(rng));
  const k = rng.int(3);
  if (k === 0) {
    return { kind: "compare", field: pick(rng, ALL_FIELDS), op: rng.next() < 0.5 ? "eq" : "ne", value: value(), ...lower };
  }
  if (k === 1) return { kind: "contains", field: pick(rng, STRING_FIELDS), value: randomString(rng), ...lower };
  const n = 1 + rng.int(4);
  return { kind: "in", field: pick(rng, ALL_FIELDS), values: Array.from({ length: n }, value), ...lower };
}

/**
 * Well-typed ASTs whose literals are mostly drawn from the traffic that will be evaluated, so
 * they actually match some requests. Used for the evaluator agreement property.
 */
export function typedAst(rng: Rng, d: TrafficDictionary, depth = 0): RuleAST {
  const leaf = depth >= 4 || rng.next() < 0.4;
  if (!leaf) {
    const k = rng.int(3);
    if (k === 0) return { kind: "and", left: typedAst(rng, d, depth + 1), right: typedAst(rng, d, depth + 1) };
    if (k === 1) return { kind: "or", left: typedAst(rng, d, depth + 1), right: typedAst(rng, d, depth + 1) };
    return { kind: "not", operand: typedAst(rng, d, depth + 1) };
  }
  const field: RuleField = pick(rng, ALL_FIELDS);
  if (NUMBER_FIELDS.some((f) => f === field)) {
    const pool =
      field === "ip.src.asnum" ? [64500, 64501, 64502, 64503, 64520, 64521, 1, 99999] : [200, 304, 401, 404, 429, 500, 503];
    const k = rng.int(2);
    if (k === 0) return { kind: "compare", field, op: rng.next() < 0.5 ? "eq" : "ne", value: pick(rng, pool) };
    return { kind: "in", field, values: Array.from({ length: 1 + rng.int(3) }, () => pick(rng, pool)) };
  }
  const sf = field as StringField;
  const entries =
    sf === "http.request.method" ? d.methods : sf === "http.request.uri.path" ? d.paths : sf === "http.user_agent" ? d.userAgents : d.countries;
  const lower = rng.next() < 0.3;
  const fromTraffic = () => {
    const raw = rng.next() < 0.85 ? pick(rng, entries) : randomString(rng);
    return lower ? raw.toLowerCase() : raw;
  };
  const lowerFlag = lower ? { lower: true as const } : {};
  const k = rng.int(3);
  if (k === 0) return { kind: "compare", field: sf, op: rng.next() < 0.5 ? "eq" : "ne", value: fromTraffic(), ...lowerFlag };
  if (k === 1) {
    const whole = fromTraffic();
    const start = rng.int(Math.max(1, whole.length));
    const sub = whole.slice(start, start + 1 + rng.int(8));
    return { kind: "contains", field: sf, value: sub, ...lowerFlag };
  }
  return { kind: "in", field: sf, values: Array.from({ length: 1 + rng.int(3) }, fromTraffic), ...lowerFlag };
}
