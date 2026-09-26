// Driver for the Phase 0 spikes that need the target account. Bundled and run by
// scripts/run-spikes.mjs. Talks to a deployed spikes/ Worker; builds prompts and verifies model
// output locally with the real core, so what is measured is exactly what production would do.
//
// Usage: node scripts/run-spikes.mjs <spike-worker-url> <model-rate|cpu|structured> [options]

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { aggregateChunk, finalizeSummary } from "../src/core/aggregator";
import { naiveBaseline } from "../src/core/baseline";
import { buildDraftRulePrompt } from "../src/core/prompt";
import { toReplayResult } from "../src/core/replay";
import { compileRule, replayChunk } from "../src/core/rules/evaluate";
import { verifyModelDraft } from "../src/core/rules/pipeline";
import { RULE_JSON_SCHEMA } from "../src/core/rules/schema";
import { findScenario, type ScenarioDefinition } from "../src/core/scenarios";
import { generateAll } from "../src/core/simulator";
import type { RuleAST } from "../src/core/types";
import type { ModelResponse } from "../src/model/client";

const [, , base, which, ...rest] = process.argv;
if (!base || !which) throw new Error("usage: run-spikes.mjs <url> <model-rate|cpu|structured>");
const url = (p: string) => new URL(p, base).toString();
const stamp = new Date().toISOString();
mkdirSync("docs/spike-results", { recursive: true });
const save = (name: string, data: unknown) => {
  writeFileSync(`docs/spike-results/${name}.json`, `${JSON.stringify({ measuredAt: stamp, ...(data as object) }, null, 2)}\n`);
  console.log(`wrote docs/spike-results/${name}.json`);
};

async function modelRate(max: number) {
  // Fire requests concurrently in waves, so the per-minute limit is actually approached.
  const results: Array<{ i: number; kind: string; ms: number; message?: string }> = [];
  const t0 = Date.now();
  let firstLimitedAt: number | null = null;
  for (let i = 0; i < max && firstLimitedAt === null; i += 20) {
    const wave = await Promise.all(
      Array.from({ length: Math.min(20, max - i) }, async (_, k) => {
        const r = (await (await fetch(url("/model/probe"))).json()) as { response: ModelResponse; ms: number };
        return { i: i + k, kind: r.response.kind, ms: r.ms, message: "message" in r.response ? r.response.message : undefined };
      }),
    );
    results.push(...wave);
    const limited = wave.find((w) => w.kind === "rate-limited");
    if (limited) firstLimitedAt = limited.i;
  }
  const elapsedMs = Date.now() - t0;
  const counts = results.reduce<Record<string, number>>((a, r) => ({ ...a, [r.kind]: (a[r.kind] ?? 0) + 1 }), {});
  save("0.1-model-rate", { max, elapsedMs, firstLimitedAt, counts, sample: results.slice(0, 3), errors: results.filter((r) => r.kind !== "ok").slice(0, 5) });
}

async function cpu() {
  const call = async (transport: string, iters: number, times: number) =>
    (await (await fetch(url(`/cpu?transport=${transport}&iters=${iters}&times=${times}`))).json()) as {
      ok: boolean;
      completed: number;
      error?: string;
    };
  // 1. Single-call ceiling over RPC: double until a call fails.
  let iters = 250_000;
  let ceiling: number | null = null;
  const ladder: Array<{ iters: number; ok: boolean; error?: string }> = [];
  while (iters <= 512_000_000) {
    const r = await call("rpc", iters, 1);
    ladder.push({ iters, ok: r.ok, error: r.error });
    if (!r.ok) {
      ceiling = iters;
      break;
    }
    iters *= 2;
  }
  if (ceiling === null) {
    save("0.2-cpu", { ladder, conclusion: "no single-call failure found; CPU limit not reached" });
    return;
  }
  // 2. Calls of 60 percent of the ceiling each, four in a row, per transport. One such call
  //    fits; four only fit if each call gets a fresh budget.
  const each = Math.floor(ceiling * 0.6);
  const rpc = await call("rpc", each, 4);
  const fetched = await call("fetch", each, 4);
  const ws = await new Promise<{ ok: boolean; completed: number; error?: string }>((resolve) => {
    const sock = new WebSocket(url("/cpu/ws").replace(/^http/, "ws"));
    let completed = 0;
    sock.addEventListener("open", () => sock.send(String(each)));
    sock.addEventListener("message", () => {
      completed++;
      if (completed === 4) {
        sock.close();
        resolve({ ok: true, completed });
      } else sock.send(String(each));
    });
    sock.addEventListener("error", () => resolve({ ok: false, completed, error: "websocket error" }));
    sock.addEventListener("close", () => resolve({ ok: completed === 4, completed }));
  });
  save("0.2-cpu", { ladder, ceilingIters: ceiling, perCallIters: each, rpc, fetch: fetched, websocket: ws });
}

function variant(def: ScenarioDefinition, id: string, change: (d: ScenarioDefinition) => ScenarioDefinition) {
  const v = change(structuredClone(def));
  return { ...v, scenario: { ...v.scenario, id } };
}

async function structured(seedsPerShape: number) {
  const trap = findScenario("cs-trap-carrier");
  if (!trap) throw new Error("scenario missing");
  const shapes: Array<{ def: ScenarioDefinition; symptom: string }> = [
    { def: trap, symptom: trap.scenario.symptom },
    {
      // Same trap, one attack user agent, different wording.
      def: variant(trap, "cs-trap-single-ua", (d) => {
        const attack = d.populations.find((p) => p.label === "attack");
        if (attack) attack.userAgents = [["okhttp/4.9.3", 1]];
        return d;
      }),
      symptom: "tons of failed logins, mostly from phones as far as I can tell",
    },
    {
      // Not a trap: the attack comes only from hosting networks.
      def: variant(trap, "cs-hosting-only", (d) => {
        const attack = d.populations.find((p) => p.label === "attack");
        if (attack) attack.asns = [[64520, 0.5], [64521, 0.3], [64522, 0.2]];
        return d;
      }),
      symptom: "our login endpoint is getting hammered and people can't sign in",
    },
  ];
  const templates = {
    system: readFileSync("prompts/draft-rule.system.txt", "utf8"),
    user: readFileSync("prompts/draft-rule.user.txt", "utf8"),
  };
  const attempts: unknown[] = [];
  for (const shape of shapes) {
    for (let s = 1; s <= seedsPerShape; s++) {
      const traffic = generateAll(shape.def, s);
      const summary = finalizeSummary(aggregateChunk(traffic, shape.def.scenario.durationMs, shape.def.scenario.symptomStatus), traffic.dictionary);
      const prompt = buildDraftRulePrompt(templates, { symptom: shape.symptom, summary });
      const r = (await (
        await fetch(url("/model/run"), {
          method: "POST",
          body: JSON.stringify({ ...prompt, schema: RULE_JSON_SCHEMA }),
        })
      ).json()) as { response: ModelResponse; ms: number };
      let validJson = false;
      let outcome: ReturnType<typeof verifyModelDraft> | null = null;
      let replay = null;
      if (r.response.kind === "ok") {
        try {
          JSON.parse(r.response.raw);
          validJson = true;
        } catch {
          validJson = false;
        }
        outcome = verifyModelDraft(r.response.raw);
        if (outcome.status === "valid" && outcome.ast) {
          const compiled = compileRule(outcome.ast, traffic.dictionary);
          if (compiled.ok) {
            replay = toReplayResult(replayChunk(compiled.rule, traffic, shape.def.scenario.durationMs).counts, shape.def.scenario.thresholds, "spike");
          }
        }
      }
      const baseline = naiveBaseline(summary);
      let baselineReplay = null;
      if (baseline) {
        const c = compileRule(baseline.ast as RuleAST, traffic.dictionary);
        if (c.ok) baselineReplay = toReplayResult(replayChunk(c.rule, traffic, shape.def.scenario.durationMs).counts, shape.def.scenario.thresholds, "spike");
      }
      attempts.push({
        shape: shape.def.scenario.id,
        seed: s,
        ms: r.ms,
        responseKind: r.response.kind,
        raw: r.response.kind === "ok" ? r.response.raw : r.response.message,
        validJson,
        status: outcome?.status ?? null,
        text: outcome?.text ?? null,
        diagnostics: outcome?.diagnostics.map((d) => d.code) ?? [],
        replay,
        baselineReplay,
      });
      console.log(`${shape.def.scenario.id} seed ${s}: ${r.response.kind} ${outcome?.status ?? ""} ${outcome?.text ?? ""}`);
    }
  }
  type A = { responseKind: string; validJson: boolean; status: string | null; replay: { passesThresholds: boolean } | null };
  const as = attempts as A[];
  const n = as.length;
  const frac = (k: number) => `${k}/${n}`;
  save("0.4-structured", {
    summary: {
      attempts: n,
      validJson: frac(as.filter((a) => a.validJson).length),
      schemaValid: frac(as.filter((a) => a.status !== null && a.status !== "invalid-schema").length),
      typeValid: frac(as.filter((a) => a.status === "valid").length),
      jsonModeFailed: frac(as.filter((a) => a.responseKind === "json-mode-failed").length),
      otherErrors: frac(as.filter((a) => a.responseKind === "error" || a.responseKind === "rate-limited").length),
      passesThresholds: frac(as.filter((a) => a.replay?.passesThresholds).length),
    },
    attempts,
  });
}

if (which === "model-rate") await modelRate(Number(rest[0] ?? "400"));
else if (which === "cpu") await cpu();
else if (which === "structured") await structured(Number(rest[0] ?? "10"));
else throw new Error(`unknown spike ${which}`);
