// Phase 0.3, cold path: one fresh Node process per run, so every function is timed on its
// first call with no warm JIT. This is closer to the first request into a new isolate than the
// warm medians in cpu.test.ts. Bundled with esbuild and run by scripts/bench-cold.mjs.
import { aggregateChunk } from "../../src/core/aggregator";
import { decodeTraffic, encodeTraffic } from "../../src/core/codec";
import { compileRule, replayChunk } from "../../src/core/rules/evaluate";
import { verifyModelDraft } from "../../src/core/rules/pipeline";
import { findScenario } from "../../src/core/scenarios";
import { generateRange } from "../../src/core/simulator";

const size = Number(process.argv[2] ?? "1000");
const def = findScenario("cs-trap-carrier");
if (!def) throw new Error("scenario missing");
const time = <T>(fn: () => T): [T, number] => {
  const t0 = performance.now();
  const v = fn();
  return [v, performance.now() - t0];
};
const [chunk, generate] = time(() => generateRange(def, 1, 0, size));
const [encoded, encode] = time(() => encodeTraffic(chunk));
const [decoded, decode] = time(() => decodeTraffic(encoded, def.scenario.id, chunk.dictionary));
if ("kind" in decoded) throw new Error(decoded.message);
const [, aggregate] = time(() => aggregateChunk(decoded, def.scenario.durationMs));
const raw = JSON.stringify({
  rule: {
    kind: "and",
    left: { kind: "compare", field: "http.request.uri.path", op: "eq", value: "/login" },
    right: {
      kind: "or",
      left: { kind: "contains", field: "http.user_agent", value: "okhttp", lower: true },
      right: { kind: "contains", field: "http.user_agent", value: "HeadlessChrome" },
    },
  },
});
const [outcome, verify] = time(() => verifyModelDraft(raw));
if (!outcome.ast) throw new Error("verify failed");
const ast = outcome.ast;
const [compiled, compile] = time(() => compileRule(ast, decoded.dictionary));
if (!compiled.ok) throw new Error("compile failed");
const [, evaluate] = time(() => replayChunk(compiled.rule, decoded, def.scenario.durationMs));
console.log(JSON.stringify({ size, generate, encode, decode, aggregate, verify, compile, evaluate }));
